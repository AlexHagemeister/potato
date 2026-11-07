// Live smoke test of the deck service: getDeck and getCard against real TMDB
// and the potato_dev database. Prints timings, per-pool yield, and a sample card.
//
// Runs only against potato_dev, never production:
//   bun run deck:smoke
// It reads DATABASE_URL from .env.development.local and only
// TMDB_API_READ_TOKEN from .env.local (Bun's automatic .env loading is off,
// since .env.local points at production). It refuses any database that is not
// potato_dev, creates one throwaway user, and deletes it at the end (its rows
// cascade). TMDB responses land in potato_dev's tmdb_cache, as in local dev.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { eq, sql } from "drizzle-orm";

const REQUIRED_DATABASE = "potato_dev";
const devEnv = parseEnv(readFileSync(".env.development.local", "utf8"));
const url = devEnv.DATABASE_URL;
if (!url) throw new Error(".env.development.local has no DATABASE_URL");
const database = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
if (database !== REQUIRED_DATABASE) {
  console.error(`Refusing to run: expected database "${REQUIRED_DATABASE}", found "${database}".`);
  process.exit(1);
}
process.env.DATABASE_URL = url;
const token = parseEnv(readFileSync(".env.local", "utf8")).TMDB_API_READ_TOKEN;
if (!token) throw new Error(".env.local has no TMDB_API_READ_TOKEN");
process.env.TMDB_API_READ_TOKEN = token;

const { getDb } = await import("../src/db/client");
const { users } = await import("../src/db/schema");
const lib = await import("../src/core/library");
const { getTmdb } = await import("../src/core/tmdb");
const { PostgresRatingsStore } = await import("../src/core/imdb");
const { createDeckService, libraryForDeck } = await import("../src/core/deck-service");
type DeckPage = import("../src/core/deck-service").DeckPage;
type DeckRequest = import("../src/core/deck-service").DeckRequest;
type DeckStats = import("../src/core/deck-service").DeckStats;

const db = getDb();
const [{ current_database: live }] = (await db.execute(sql`select current_database()`)).rows as [{ current_database: string }];
if (live !== REQUIRED_DATABASE) {
  console.error(`Refusing to run: connected to "${live}", not "${REQUIRED_DATABASE}".`);
  process.exit(1);
}
const [{ n: imdbRows }] = (await db.execute(sql`select count(*)::int as n from imdb_ratings`)).rows as [{ n: number }];
console.log(`Connected to ${live}. imdb_ratings rows: ${imdbRows}.`);

let lastStats: DeckStats | undefined;
const service = createDeckService({
  tmdb: getTmdb(),
  ratings: new PostgresRatingsStore(),
  library: libraryForDeck,
  onStats: (s) => (lastStats = s),
});

const userId = `smoke-${randomUUID().slice(0, 8)}`;
await db.insert(users).values({ id: userId, name: "Deck smoke", email: `${userId}@example.invalid` });

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`core error: ${JSON.stringify(r.error)}`);
  return r.value;
}

async function run(label: string, request: DeckRequest): Promise<DeckPage> {
  const started = performance.now();
  const page = must(await service.getDeck(userId, request));
  const ms = Math.round(performance.now() - started);
  if (page.kind === "locked") {
    console.log(`${label}: locked (${page.ratedCount}/${page.required}), ${ms} ms`);
    return page;
  }
  if (page.kind === "no_seeds") {
    console.log(`${label}: no seeds of ${page.mediaTypes.join(", ")}, ${ms} ms`);
    return page;
  }
  const pools = Object.entries(lastStats?.pools ?? {})
    .map(([pool, s]) => `${pool} ${s.taken}/${s.enriched}/${s.dealt}`)
    .join(", ");
  console.log(
    `${label}: ${page.cards.length} cards in ${ms} ms; lists ${lastStats?.listLookups}, details ${lastStats?.detailLookups}; ` +
      `taken/enriched/dealt: ${pools}; next cursor ${page.nextCursor ? "yes" : "none"}`,
  );
  const rated = page.cards.filter((c) => c.imdb.kind === "rated").length;
  console.log(
    `  IMDb rated on ${rated}/${page.cards.length}; on my services ${page.cards.filter((c) => c.streaming.onMyServices).length}/${page.cards.length}; ` +
      `movies ${page.cards.filter((c) => c.mediaType === "movie").length}; first: ` +
      page.cards
        .slice(0, 4)
        .map((c) => `${c.title} (${c.year}) [${c.mediaType}:${c.tmdbId}, ${c.source}]`)
        .join("; "),
  );
  return page;
}

try {
  must(await lib.updateUserSettings(userId, { country: "US", providerIds: [8, 9, 15, 337, 1899] }));

  const first = await run("blend, first call", {});
  await run("blend, same call again (warm cache)", {});
  if (first.kind === "cards" && first.nextCursor) await run("blend, page 2", { cursor: first.nextCursor });

  for (const mode of ["popular", "top_rated", "deep_cuts"] as const) await run(mode, { mode });

  await run("VISION test case: modern sci-fi series on my services", {
    mode: "blend",
    filters: { mediaTypes: ["tv"], genreIds: [10765], era: { fromYear: 2015 }, onMyServices: true },
  });

  await run("for you before 10 ratings", { mode: "for_you" });
  const seen: [("movie" | "tv"), number, number][] = [
    ["movie", 603, 5], ["movie", 27205, 4.5], ["movie", 157336, 5], ["movie", 155, 4.5], ["movie", 680, 4],
    ["movie", 550, 4], ["movie", 278, 5], ["tv", 1396, 5], ["tv", 66732, 4], ["tv", 95396, 4.5],
  ];
  for (const [mediaType, tmdbId, rating] of seen) must(await lib.markSeen(userId, { mediaType, tmdbId }, { rating }));
  const forYou = await run("for you after 10 ratings", { mode: "for_you" });
  if (forYou.kind === "cards" && forYou.nextCursor) await run("for you, page 2", { mode: "for_you", cursor: forYou.nextCursor });
  await run("blend with for you unlocked", {});

  // A cursor is bound to the user's country and services: after a change it is rejected, not silently replayed.
  const before = await run("blend before a services change", {});
  must(await lib.updateUserSettings(userId, { country: "US", providerIds: [8, 9] }));
  if (before.kind === "cards" && before.nextCursor) {
    const stale = await service.getDeck(userId, { cursor: before.nextCursor });
    console.log(`stale cursor after a services change: ${stale.ok ? "accepted (WRONG)" : JSON.stringify(stale.error)}`);
  }

  for (const ref of [
    { mediaType: "movie" as const, tmdbId: 603 },
    { mediaType: "tv" as const, tmdbId: 95396 },
    { mediaType: "tv" as const, tmdbId: 999_999_999 },
  ]) {
    const started = performance.now();
    const card = await service.getCard(userId, ref);
    const ms = Math.round(performance.now() - started);
    if (!card.ok) {
      console.log(`getCard ${ref.mediaType}:${ref.tmdbId} in ${ms} ms: ${JSON.stringify(card.error)}`);
      continue;
    }
    const c = card.value;
    const trimmed = {
      ...c,
      synopsis: c.synopsis.length > 90 ? `${c.synopsis.slice(0, 90)}...` : c.synopsis,
      streaming: { ...c.streaming, providers: c.streaming.providers.slice(0, 4) },
    };
    console.log(`getCard ${ref.mediaType}:${ref.tmdbId} in ${ms} ms:\n${JSON.stringify(trimmed, null, 2)}`);
  }
} finally {
  await db.delete(users).where(eq(users.id, userId));
  console.log(`Deleted throwaway user ${userId}.`);
}
