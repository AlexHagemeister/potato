// What the Profile tab shows and changes: the user's settings, the countries
// to pick from, and the streaming services in the chosen country.

import { logoUrl } from "../tmdb/images";
import { getTmdbClient, getWatchRegionsFromEnv } from "../tmdb/default-client";
import type { ProviderListEntry } from "../tmdb/types";
import type { WatchRegion } from "../tmdb/regions";
import { parseCountry, setCountry } from "./settings";
import { getUserSettings } from "./user-settings";

/** A streaming service as the Profile tab lists it. Data from JustWatch, via TMDB. */
export interface StreamingService {
  id: number;
  name: string;
  logoUrl: string | null;
}

export interface ProfileSettings {
  settings: { country: string; providerIds: number[] };
  countries: WatchRegion[];
  services: StreamingService[];
}

export function toStreamingServices(list: readonly ProviderListEntry[]): StreamingService[] {
  return list.map((p) => ({ id: p.id, name: p.name, logoUrl: logoUrl(p.logoPath, "w92") }));
}

/**
 * The picker's countries. A saved country TMDB no longer lists is kept, so the
 * picker can always show what is saved.
 */
export function countriesFor(saved: string, regions: readonly WatchRegion[]): WatchRegion[] {
  if (regions.some((r) => r.code === saved)) return [...regions];
  return [...regions, { code: saved, name: saved }].sort((a, b) => a.name.localeCompare(b.name, "en"));
}

/** The streaming services available in a country, in TMDB's display order. */
export async function listStreamingServices(country: unknown): Promise<StreamingService[]> {
  const code = parseCountry(country);
  return toStreamingServices(await getTmdbClient().getProviderList(code));
}

/** Everything the Profile tab needs on first render. */
export async function getProfileSettings(userId: string): Promise<ProfileSettings> {
  const { country, providerIds } = await getUserSettings(userId);
  const [regions, services] = await Promise.all([getWatchRegionsFromEnv(), listStreamingServices(country)]);
  return { settings: { country, providerIds }, countries: countriesFor(country, regions), services };
}

/** Saves a new country and returns that country's streaming services. */
export async function changeCountry(userId: string, country: unknown): Promise<StreamingService[]> {
  const code = parseCountry(country);
  await setCountry(userId, code);
  return listStreamingServices(code);
}
