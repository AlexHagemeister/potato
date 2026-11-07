// Loads IMDb ratings into the local potato_dev database, with the same core
// function the daily cron runs in production.
//
// Run: bun run imdb:load:dev             (loads into potato_dev)
//      bun run imdb:load:dev --dry-run   (downloads and parses, writes nothing)
//
// The connection strings come only from .env.development.local, never from
// the inherited environment (Bun auto-loads .env files, and .env.local points
// at production). The script refuses any database other than potato_dev.

import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { count } from "drizzle-orm";
import { getDb } from "../src/db/client";
import { imdbRatings } from "../src/db/schema";
import { createPostgresRatingsLoadTarget, loadImdbRatings, MemoryLoadTarget } from "../src/core/imdb";

const ENV_FILE = ".env.development.local";
const DEV_DATABASE = "potato_dev";

function databaseName(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, "")) || null;
  } catch {
    return null;
  }
}

async function main() {
  if (process.argv.includes("--dry-run")) {
    console.log("dry run: download and parse only, no database writes");
    console.log(await loadImdbRatings({ target: new MemoryLoadTarget(false) }));
    return;
  }

  if (!existsSync(ENV_FILE)) throw new Error(`Missing ${ENV_FILE} (the potato_dev connection strings).`);
  const env = parseEnv(readFileSync(ENV_FILE, "utf8"));
  for (const name of ["DATABASE_URL", "DATABASE_URL_UNPOOLED"] as const) {
    const db = databaseName(env[name]);
    if (db !== DEV_DATABASE) throw new Error(`Refusing to load: ${name} in ${ENV_FILE} points at ${db ?? "nothing"}, not ${DEV_DATABASE}.`);
    process.env[name] = env[name];
  }
  console.log(`database: ${DEV_DATABASE} (${new URL(env.DATABASE_URL!).hostname})`);

  const result = await loadImdbRatings({ target: createPostgresRatingsLoadTarget() });
  console.log(result);
  const [{ rows }] = await getDb().select({ rows: count() }).from(imdbRatings);
  console.log(`imdb_ratings now holds ${rows} rows`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
