// What the Profile tab shows and changes: the user's settings, the countries
// to pick from, and the streaming services in the chosen country.

import { fail, ok, type Result } from "../result";
import { getTmdb, logoUrl, type ProviderListEntry, type WatchRegion } from "../tmdb";
import { getUserSettings, updateUserSettings, validateSettingsPatch } from "./user-settings";

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
  /** True when TMDB could not supply the services list. The rest of the tab still works. */
  servicesUnavailable: boolean;
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

/** The streaming services available in a country (an uppercase ISO code), in TMDB's display order. */
async function listStreamingServices(country: string): Promise<StreamingService[]> {
  return toStreamingServices(await getTmdb().getProviderList(country));
}

/**
 * Everything the Profile tab needs on first render. A TMDB failure degrades
 * the tab instead of failing it, so the account section and Sign out always
 * work: without regions the picker offers only the saved country, and without
 * services the list shows an error.
 */
export async function getProfileSettings(userId: string): Promise<Result<ProfileSettings>> {
  const read = await getUserSettings(userId);
  if (!read.ok) return read;
  const { country, providerIds } = read.value;
  const [regions, services] = await Promise.allSettled([getTmdb().getWatchRegions(), listStreamingServices(country)]);
  if (regions.status === "rejected") console.error("watch regions unavailable:", regions.reason);
  if (services.status === "rejected") console.error(`streaming services unavailable for ${country}:`, services.reason);
  return ok({
    settings: { country, providerIds },
    countries: countriesFor(country, regions.status === "fulfilled" ? regions.value : []),
    services: services.status === "fulfilled" ? services.value : [],
    servicesUnavailable: services.status === "rejected",
  });
}

/**
 * Saves a new country and returns that country's streaming services. The
 * country is checked against TMDB's list first, so an unknown code costs no
 * services fetch. The services list is fetched before saving, so a TMDB
 * failure leaves the saved country unchanged and the screen and the database
 * agree.
 */
export async function changeCountry(userId: string, country: unknown): Promise<Result<StreamingService[]>> {
  const valid = validateSettingsPatch({ country });
  if (!valid.ok) return valid;
  const code = valid.value.country!;
  const regions = await getTmdb().getWatchRegions();
  if (!regions.some((r) => r.code === code)) return fail({ code: "unknown_country", country: code });
  const services = await listStreamingServices(code);
  // Saved services are kept. Provider IDs are global, so one the new country
  // lacks matches nothing there, and switching back restores it. The regions
  // just read are passed on, so the save doesn't look them up again.
  const saved = await updateUserSettings(userId, { country: code }, { watchRegions: async () => regions });
  if (!saved.ok) return saved;
  return ok(services);
}
