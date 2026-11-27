import { afterEach, describe, expect, test } from "bun:test";
import { getDb, withTransaction } from "./client";
import { devDatabaseGuardRefusal, type DevDatabaseGuardEnv } from "./dev-guard";

const DEV_URL = "postgresql://u:secret-pw@host.example/potato_dev?sslmode=require";
const PROD_URL = "postgresql://u:secret-pw@host.example/neondb?sslmode=require";

/** A local dev run pointed at the wrong database: the one case that refuses. */
const wrong: DevDatabaseGuardEnv = {
  nodeEnv: "development",
  vercelEnv: undefined,
  url: PROD_URL,
  variable: "DATABASE_URL",
};

describe("devDatabaseGuardRefusal", () => {
  test("refuses a local development run whose database is not potato_dev", () => {
    expect(devDatabaseGuardRefusal(wrong)).toBeString();
  });

  test("allows a local development run against potato_dev", () => {
    expect(devDatabaseGuardRefusal({ ...wrong, url: DEV_URL })).toBeNull();
  });

  test("never fires in production, whatever the database", () => {
    for (const url of [PROD_URL, DEV_URL, "not a url", "", undefined]) {
      for (const vercelEnv of [undefined, "", "production", "preview", "development"]) {
        expect(devDatabaseGuardRefusal({ ...wrong, nodeEnv: "production", vercelEnv, url })).toBeNull();
      }
    }
  });

  test("never fires under test or with NODE_ENV unset (scripts)", () => {
    for (const nodeEnv of ["test", undefined, ""]) {
      expect(devDatabaseGuardRefusal({ ...wrong, nodeEnv })).toBeNull();
    }
  });

  test("NODE_ENV must match exactly", () => {
    for (const nodeEnv of ["Development", "DEVELOPMENT", "dev", " development", "development "]) {
      expect(devDatabaseGuardRefusal({ ...wrong, nodeEnv })).toBeNull();
    }
  });

  test("never fires on any Vercel environment, even with NODE_ENV=development", () => {
    for (const vercelEnv of ["production", "preview", "development"]) {
      expect(devDatabaseGuardRefusal({ ...wrong, vercelEnv })).toBeNull();
    }
  });

  test("in development, a URL it can't read a database name from is refused", () => {
    for (const url of ["not a url", "", undefined, "postgresql://u:p@host.example/"]) {
      expect(devDatabaseGuardRefusal({ ...wrong, url })).toContain('"(none)"');
    }
  });

  test("only the exact name potato_dev passes", () => {
    for (const name of ["potato_dev2", "potato", "POTATO_DEV", "potato_dev/x", "neondb"]) {
      const url = `postgresql://u:p@host.example/${name}`;
      expect(devDatabaseGuardRefusal({ ...wrong, url })).toBeString();
    }
  });

  test("the message names the database, the variable, the missing file, and the fix", () => {
    const message = devDatabaseGuardRefusal({ ...wrong, variable: "DATABASE_URL_UNPOOLED" })!;
    expect(message).toContain('"neondb"');
    expect(message).toContain('"potato_dev"');
    expect(message).toContain("DATABASE_URL_UNPOOLED names");
    expect(message).toContain(".env.development.local");
    expect(message).toContain("Copy .env.development.local from the main checkout");
  });

  test("the message never carries the URL, its host, or its password", () => {
    const message = devDatabaseGuardRefusal(wrong)!;
    expect(message).not.toContain("secret-pw");
    expect(message).not.toContain("host.example");
    expect(message).not.toContain("postgresql://");
  });

  // A malformed URL can parse with the password or host inside the path, so
  // the parsed "database name" would carry them into the message.
  test("a malformed URL is still refused, and nothing from it reaches the message", () => {
    const malformed = [
      "postgresql:u:secret-pw@host.example/neondb", // no slashes: all of it is the path
      "postgresql://u:1234/secret-pw@host.example/neondb", // a slash in the password
      "postgresql:/u:secret-pw@host.example/neondb", // one slash
      "postgresql:///u:secret-pw@host.example/neondb", // three slashes
      "postgresql://host.example/u:secret-pw@host.example", // credentials as the path
      "postgresql://u:p@other.example/secret-pw%40host.example", // encoded, decoded by the parser
      "postgresql://u:p@other.example/secret-pw%2Fhost.example",
      "postgresql://u:p@other.example/neondb/secret-pw/host.example", // extra path segments
      "postgresql://u:p@other.example/potato_dev/secret-pw", // potato_dev as a prefix only
      "postgresql://u:p@other.example/secret-pw host.example", // a space
      `postgresql://u:p@other.example/${"secret-pw".repeat(8)}`, // too long to be a name
      "postgresql:secret-pw", // no host: the password alone, shaped like a name
      "postgresql:/secret-pw",
      "postgresql:///secret-pw",
      "postgresql://u:1234/secret-pw", // cut off after a slash in the password
      "postgresql://host.example:5432/secret-pw", // no user
      "https://u:p@other.example/secret-pw", // not Postgres
      "u:secret-pw@host.example/neondb", // no scheme: "u:" is read as one
      "file:///secret-pw/host.example",
    ];
    for (const url of malformed) {
      for (const variable of ["DATABASE_URL", "DATABASE_URL_UNPOOLED"]) {
        const message = devDatabaseGuardRefusal({ ...wrong, url, variable });
        expect(message).toBeString();
        expect(message).not.toContain("secret-pw");
        expect(message).not.toContain("host.example");
        expect(message).not.toContain("1234");
        expect(message).not.toContain("@");
        expect(message).toMatch(/names the database "\((unreadable|none)\)"/);
      }
    }
  });

  test("a plainly shaped name is printed, anything else is a fixed placeholder", () => {
    const refusal = (name: string) =>
      devDatabaseGuardRefusal({ ...wrong, url: `postgresql://u:p@host.example/${name}` })!;
    expect(refusal("neondb")).toContain('"neondb"');
    expect(refusal("my-db_2")).toContain('"my-db_2"');
    expect(refusal("a.b")).toContain('"(unreadable)"');
    expect(refusal("a%20b")).toContain('"(unreadable)"');
    expect(refusal("a".repeat(64))).toContain('"(unreadable)"');
    const postgres = devDatabaseGuardRefusal({ ...wrong, url: "postgres://u:p@host.example/neondb" })!;
    expect(postgres).toContain('"neondb"');
  });
});

// The wiring: getDb() and withTransaction() read the real environment, so
// these tests set it and put it back. Only refusals are exercised here. A
// refusal throws before any client is built or cached, so nothing leaks into
// other test files and nothing connects.
describe("the client applies the guard", () => {
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    VERCEL_ENV: process.env.VERCEL_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
  };
  const env = process.env as Record<string, string | undefined>;

  function setEnv(values: Partial<typeof saved>): void {
    for (const key of Object.keys(saved) as (keyof typeof saved)[]) {
      if (values[key] === undefined) delete env[key];
      else env[key] = values[key];
    }
  }

  afterEach(() => setEnv(saved));

  test("getDb throws in development when DATABASE_URL is not potato_dev", () => {
    setEnv({ NODE_ENV: "development", DATABASE_URL: PROD_URL });
    expect(() => getDb()).toThrow(/Refusing to open a database connection in development: DATABASE_URL names/);
  });

  test("withTransaction rejects in development before running its callback", async () => {
    setEnv({ NODE_ENV: "development", DATABASE_URL: DEV_URL, DATABASE_URL_UNPOOLED: PROD_URL });
    let ran = false;
    const attempt = withTransaction(async () => {
      ran = true;
    });
    await expect(attempt).rejects.toThrow(/DATABASE_URL_UNPOOLED names the database "neondb"/);
    expect(ran).toBe(false);
  });

  test("withTransaction checks DATABASE_URL when there is no unpooled URL", async () => {
    setEnv({ NODE_ENV: "development", DATABASE_URL: PROD_URL });
    await expect(withTransaction(async () => {})).rejects.toThrow(/DATABASE_URL names the database "neondb"/);
  });

  test("the environment is put back after each test", () => {
    expect(process.env.NODE_ENV).toBe(saved.NODE_ENV);
    expect(process.env.DATABASE_URL).toBe(saved.DATABASE_URL);
  });
});
