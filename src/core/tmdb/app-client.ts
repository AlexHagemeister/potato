// The app's TMDB client: the one instance the app uses, wired here so the
// client itself (client.ts) stays free of app wiring and dev scaffolding.

import { PostgresCacheStore } from "../cache/postgres-cache-store";
import { createTmdbClientFromEnv, type TmdbClient } from "./client";
import { DEV_UNKNOWN_PROVIDERS_VAR, devUnknownProviderTitles, withUnknownProviders } from "./dev-unknown-providers";

let appClient: TmdbClient | undefined;

/**
 * The app's TMDB client: environment token, Postgres cache (tmdb_cache).
 * Created on first use. In a local dev run only, the dev seam can make chosen
 * titles' availability unknown (dev-unknown-providers.ts).
 */
export function getTmdb(): TmdbClient {
  appClient ??= createAppClient();
  return appClient;
}

function createAppClient(): TmdbClient {
  const cache = new PostgresCacheStore();
  const unknownTitles = devUnknownProviderTitles({
    // Literal member access on purpose: Next.js replaces process.env.NODE_ENV
    // with "production" in `next build` output, so the seam can't be turned on there.
    nodeEnv: process.env.NODE_ENV,
    vercelEnv: process.env.VERCEL_ENV,
    databaseUrl: process.env.DATABASE_URL,
    titles: process.env[DEV_UNKNOWN_PROVIDERS_VAR],
  });
  if (!unknownTitles) return createTmdbClientFromEnv(cache);
  console.warn(`${DEV_UNKNOWN_PROVIDERS_VAR}: streaming availability is unknown for ${[...unknownTitles].join(", ")} (dev only)`);
  const seam = withUnknownProviders(unknownTitles, cache, (input, init) => fetch(input, init));
  return createTmdbClientFromEnv(seam.cache, seam.fetch);
}
