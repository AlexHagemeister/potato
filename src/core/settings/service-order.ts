// Which streaming services the Profile picker shows, and in what order. A
// country lists hundreds of services (about 340 in the US), so the picker
// opens on the most-used ones and reaches the rest by search or "Show all".
// Pure, so the client component can call it and tests need no database.

/** How many services the picker shows before "Show all". */
export const POPULAR_SERVICES_COUNT = 20;

/** The fields the ordering reads. StreamingService has them. */
export interface NamedService {
  id: number;
  name: string;
}

/**
 * A storefront variant of another service, sold through Amazon, Apple TV, or
 * Roku ("HBO Max Amazon Channel"). JustWatch lists these as separate
 * services, which crowds the top of a country's list. The match is an exact
 * suffix list, case-insensitive, because TMDB's names vary in case and
 * trailing space.
 */
const CHANNEL_SUFFIX = /\s+(?:amazon|apple tv|roku premium)\s+channel$/i;

/** The base name of a storefront channel ("HBO Max" for "HBO Max Amazon Channel"), or null when the name is not a channel. */
export function channelBaseName(name: string): string | null {
  const trimmed = name.trim();
  const match = CHANNEL_SUFFIX.exec(trimmed);
  return match ? trimmed.slice(0, match.index) : null;
}

/**
 * The services the picker opens on, for a list already in the country's
 * display order (TMDB's per-country display_priorities, via
 * getProviderList).
 *
 * - The first `count` services that are not storefront channels.
 * - A channel ranks its base service: when "HBO Max Amazon Channel" sits
 *   above "HBO Max", "HBO Max" takes the channel's place. This only happens
 *   when a service with exactly the base name is in the same list.
 * - Every id in `keepIds` is included wherever it ranks, channels too, so a
 *   saved service is always visible and a row never vanishes under the tap
 *   that deselects it.
 *
 * The result keeps the list's order, with each base service at its
 * promoted rank.
 */
export function popularServices<T extends NamedService>(
  services: readonly T[],
  keepIds: Iterable<number> = [],
  count: number = POPULAR_SERVICES_COUNT,
): T[] {
  const keep = new Set(keepIds);
  const rank = new Map<number, number>(services.map((s, i) => [s.id, i]));
  const byName = new Map<string, T>();
  for (const s of services) {
    const key = s.name.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, s);
  }
  const channels = new Set<number>();
  services.forEach((s, i) => {
    const base = channelBaseName(s.name);
    if (base === null) return;
    channels.add(s.id);
    const baseService = byName.get(base.toLowerCase());
    if (baseService && i < rank.get(baseService.id)!) rank.set(baseService.id, i);
  });
  const byRank = (a: T, b: T) => rank.get(a.id)! - rank.get(b.id)!;
  const top = services
    .filter((s) => !channels.has(s.id))
    .sort(byRank)
    .slice(0, Math.max(0, count));
  const shown = new Set(top.map((s) => s.id));
  const kept = services.filter((s) => keep.has(s.id) && !shown.has(s.id));
  return [...top, ...kept].sort(byRank);
}

/** Services whose name contains the query, ignoring case and surrounding space. An empty query matches all. */
export function filterServices<T extends NamedService>(services: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  return q ? services.filter((s) => s.name.toLowerCase().includes(q)) : [...services];
}

/**
 * The rows the picker shows. A search looks through every service in the
 * country. Without one, the picker shows the popular group, or the whole list
 * once the user asks for it.
 */
export function servicesToShow<T extends NamedService>(
  services: readonly T[],
  options: { query: string; showAll: boolean; keepIds: Iterable<number> },
): T[] {
  if (options.query.trim()) return filterServices(services, options.query);
  if (options.showAll) return [...services];
  return popularServices(services, options.keepIds);
}
