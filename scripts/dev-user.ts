// The walk kit: manage a per-agent test user in potato_dev (issue 59).
//
//   bun run dev:user show  <slug>   count the user's rows
//   bun run dev:user reset <slug>   delete its title rows and settings
//   bun run dev:user seed  <slug>   write two titles to each list (overwrites rows for those titles)
//   bun run dev:user delete <slug>  delete the user and everything it owns
//
// <slug> names dev-test-<slug>@example.com, the user /api/dev/login?as=<slug>
// signs in. The shared test user needs --shared in place of a slug.
//
// Runs only against potato_dev. It reads the URL from .env.development.local
// alone (Bun's automatic .env loading is off, since .env.local points at
// production), refuses any URL whose database is not potato_dev before
// connecting, and checks current_database() over the same connection before
// reading or writing anything. Every query is scoped to the one user id found
// by exact email, so no other user's rows are touched.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { eq, sql } from "drizzle-orm";
import { databaseNameFromUrl, devDatabaseRefusal } from "../src/core/auth/dev-user";
import { SEED_ROWS, USAGE, parseDevUserArgs } from "./dev-user-kit";

const ENV_FILE = ".env.development.local";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const parsed = parseDevUserArgs(process.argv.slice(2));
if (!parsed.ok) fail(`${parsed.error}\n\n${USAGE}`);
const target = parsed.target;

if (!existsSync(ENV_FILE)) fail(`Missing ${ENV_FILE}. It holds the potato_dev connection strings.`);
const url = parseEnv(readFileSync(ENV_FILE, "utf8")).DATABASE_URL;
if (!url) fail(`${ENV_FILE} has no DATABASE_URL.`);
const urlRefusal = devDatabaseRefusal(databaseNameFromUrl(url), `The database in ${ENV_FILE}`);
if (urlRefusal) fail(`Refusing to run: ${urlRefusal}.`);
process.env.DATABASE_URL = url;

const { getDb } = await import("../src/db/client");
const { titleStatus, userSettings, users } = await import("../src/db/schema");
const { skipUntilFrom } = await import("../src/core/deck/constants");

const db = getDb();
const live = (await db.execute<{ name: string }>(sql`select current_database() as name`)).rows[0]?.name;
const liveRefusal = devDatabaseRefusal(live, "The connected database");
if (liveRefusal) fail(`Refusing to run: ${liveRefusal}.`);

console.log(`${target.command} ${target.email} (database ${live})`);

async function findUserId(): Promise<string | null> {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, target.email));
  return rows[0]?.id ?? null;
}

async function show(userId: string): Promise<void> {
  const counts = await db
    .select({ status: titleStatus.status, n: sql<number>`count(*)::int` })
    .from(titleStatus)
    .where(eq(titleStatus.userId, userId))
    .groupBy(titleStatus.status);
  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c.n]));
  const settings = await db
    .select({ userId: userSettings.userId })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  console.log(
    `  watchlist ${byStatus.watchlist ?? 0}, passed ${byStatus.passed ?? 0}, ` +
      `seen ${byStatus.seen ?? 0}, skipped ${byStatus.skipped ?? 0}; ` +
      `settings ${settings.length > 0 ? "saved" : "default"}`,
  );
}

async function ensureUser(): Promise<string> {
  const existing = await findUserId();
  if (existing) return existing;
  // The same email and name the dev login uses, so a later sign-in finds
  // this user. The settings row is created on first read, as for any user.
  await db
    .insert(users)
    .values({ id: randomUUID(), email: target.email, name: target.name, emailVerified: true })
    .onConflictDoNothing({ target: users.email });
  const id = await findUserId();
  if (!id) fail("Could not create the user.");
  console.log("  created the user");
  return id;
}

switch (target.command) {
  case "show": {
    const userId = await findUserId();
    if (!userId) console.log("  no such user yet (it is created on first sign-in or seed)");
    else await show(userId);
    break;
  }
  case "reset": {
    const userId = await findUserId();
    if (!userId) {
      console.log("  no such user yet, nothing to reset");
      break;
    }
    const titles = await db
      .delete(titleStatus)
      .where(eq(titleStatus.userId, userId))
      .returning({ tmdbId: titleStatus.tmdbId });
    const settings = await db
      .delete(userSettings)
      .where(eq(userSettings.userId, userId))
      .returning({ userId: userSettings.userId });
    console.log(`  deleted ${titles.length} title rows and ${settings.length} settings row`);
    await show(userId);
    break;
  }
  case "seed": {
    const userId = await ensureUser();
    const skipUntil = skipUntilFrom(new Date());
    for (const row of SEED_ROWS) {
      const values = {
        status: row.status,
        rating: row.rating,
        review: row.review,
        skipUntil: row.status === "skipped" ? skipUntil : null,
      };
      await db
        .insert(titleStatus)
        .values({ userId, mediaType: row.mediaType, tmdbId: row.tmdbId, ...values })
        .onConflictDoUpdate({
          target: [titleStatus.userId, titleStatus.mediaType, titleStatus.tmdbId],
          set: values,
        });
    }
    console.log(`  seeded ${SEED_ROWS.length} title rows`);
    await show(userId);
    break;
  }
  case "delete": {
    const userId = await findUserId();
    if (!userId) {
      console.log("  no such user, nothing to delete");
      break;
    }
    // Sessions, title rows, and settings cascade from the user row.
    await db.delete(users).where(eq(users.id, userId));
    console.log("  deleted the user and everything it owned");
    break;
  }
}
