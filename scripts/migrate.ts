// Applies the SQL migrations in drizzle/ to one named database.
//
//   bun run db:migrate        -> potato_dev (reads .env.development.local)
//   bun run db:migrate:prod   -> neondb, production (reads .env.local)
//
// The script reads exactly one env file, prints the host and database it will
// touch, and refuses to run if the database name in that file is not the one
// the target expects. Add --dry-run to print the target and stop.
//
// It uses the WebSocket Pool driver, not the app's HTTP driver, because the
// Pool migrator runs all pending migrations inside one transaction.

import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";

const TARGETS = {
  dev: { envFile: ".env.development.local", database: "potato_dev", label: "local dev" },
  prod: { envFile: ".env.local", database: "neondb", label: "PRODUCTION" },
} as const;

const targetName = process.argv[2];
if (targetName !== "dev" && targetName !== "prod") {
  console.error("Usage: bun --no-env-file scripts/migrate.ts <dev|prod>");
  process.exit(1);
}
const target = TARGETS[targetName];

// The URL comes only from the target's env file, never from process.env:
// Bun loads .env files automatically, and which one wins depends on NODE_ENV
// (.env.local points at production), so an inherited DATABASE_URL can't be
// trusted here.
const env = parseEnv(readFileSync(target.envFile, "utf8"));
// Migrations use the direct (unpooled) connection, as Neon recommends for DDL.
const url = env.DATABASE_URL_UNPOOLED;
if (!url) {
  console.error(`${target.envFile} has no DATABASE_URL_UNPOOLED.`);
  process.exit(1);
}

const parsed = new URL(url);
const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
console.log(`Target: ${target.label}`);
console.log(`  env file: ${target.envFile}`);
console.log(`  host:     ${parsed.hostname}`);
console.log(`  database: ${database}`);

if (database !== target.database) {
  console.error(`Refusing to run: expected database "${target.database}", found "${database}".`);
  process.exit(1);
}

if (process.argv.includes("--dry-run")) {
  console.log("Dry run: no migrations applied.");
  process.exit(0);
}

const pool = new Pool({ connectionString: url });
try {
  await migrate(drizzle({ client: pool }), { migrationsFolder: "./drizzle" });
  console.log("Migrations applied.");
} finally {
  await pool.end();
}
