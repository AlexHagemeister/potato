// Loads IMDb ratings into the local potato_dev database, with the same core
// function the daily cron runs in production.
//
// Run: bun run imdb:load:dev             (loads into potato_dev)
//      bun run imdb:load:dev --dry-run   (downloads and parses, writes nothing)
//
// The package script passes --no-env-file --env-file=.env.development.local,
// so .env.local (production) is never loaded. As a second guard, this script
// refuses any DATABASE_URL whose database is not potato_dev.

import { loadImdbRatings, MemoryLoadTarget } from "../src/core/imdb";

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
  const dryRun = process.argv.includes("--dry-run");

  if (dryRun) {
    console.log("dry run: download and parse only, no database writes");
    const result = await loadImdbRatings({ target: new MemoryLoadTarget(false) });
    console.log(result);
    return;
  }

  const db = databaseName(process.env.DATABASE_URL);
  console.log(`database: ${db ?? "(DATABASE_URL not set)"}`);
  if (db !== DEV_DATABASE) {
    throw new Error(`Refusing to load: DATABASE_URL must point at ${DEV_DATABASE}, not ${db ?? "nothing"}.`);
  }
  throw new Error("The Postgres load target is not wired yet (waiting on the db-auth PR). Use --dry-run.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
