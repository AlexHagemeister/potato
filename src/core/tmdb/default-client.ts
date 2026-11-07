// The app's shared TMDB access: the env token plus the Postgres cache. Lazy,
// so importing this reads no env var and opens no connection (next build in
// CI has neither a token nor a database).

import { PgCacheStore } from "../cache/pg-cache-store";
import { createTmdbClientFromEnv, type TmdbClient } from "./client";
import { getWatchRegions, type WatchRegion } from "./regions";

let cache: PgCacheStore | undefined;
let client: TmdbClient | undefined;

function getCache(): PgCacheStore {
  cache ??= new PgCacheStore();
  return cache;
}

/** The TMDB client the app uses, backed by the tmdb_cache table. */
export function getTmdbClient(): TmdbClient {
  client ??= createTmdbClientFromEnv(getCache());
  return client;
}

/** TMDB's watch-provider countries, through the same cache. */
export function getWatchRegionsFromEnv(): Promise<WatchRegion[]> {
  const token = process.env.TMDB_API_READ_TOKEN;
  if (!token) throw new Error("TMDB_API_READ_TOKEN is not set");
  return getWatchRegions({ token, cache: getCache() });
}
