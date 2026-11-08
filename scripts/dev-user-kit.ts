// The pure half of the walk kit (scripts/dev-user.ts): argument parsing and
// the seed rows. No database or file access, so unit tests import it freely.

import { devTestUser, validateDevUserSlug } from "../src/core/auth/dev-user";

export const COMMANDS = ["show", "reset", "seed", "delete"] as const;
export type Command = (typeof COMMANDS)[number];

export const USAGE = `Usage: bun run dev:user <command> <slug>
       bun run dev:user <command> --shared

Commands (potato_dev only):
  show    count the user's rows by list, and whether settings exist
  reset   delete the user's title rows and settings (sessions stay signed in)
  seed    write two titles to each list: watchlist, passed, seen (rated, one reviewed), skipped. Overwrites rows for those titles, keeps the rest
          (creates the user if it does not exist yet)
  delete  delete the user and everything it owns

<slug> names the test user dev-test-<slug>@example.com, the one
/api/dev/login?as=<slug> signs in. --shared targets the shared user
(dev-test-user@example.com), which other agents may be using.`;

export interface DevUserTarget {
  command: Command;
  /** null targets the shared test user. */
  slug: string | null;
  email: string;
  name: string;
}

export type ParseResult = { ok: true; target: DevUserTarget } | { ok: false; error: string };

/**
 * Reads `<command> <slug>` or `<command> --shared`. The shared user is
 * reachable only through the explicit flag, never by leaving the slug out.
 */
export function parseDevUserArgs(args: readonly string[]): ParseResult {
  const flags = args.filter((a) => a.startsWith("-"));
  const positional = args.filter((a) => !a.startsWith("-"));
  const unknown = flags.filter((f) => f !== "--shared");
  if (unknown.length > 0) return { ok: false, error: `Unknown option: ${unknown.join(", ")}` };
  const shared = flags.includes("--shared");

  const [command, slug, ...extra] = positional;
  if (!command) return { ok: false, error: "Give a command." };
  if (!(COMMANDS as readonly string[]).includes(command)) {
    return { ok: false, error: `Unknown command: ${command}` };
  }
  if (extra.length > 0) return { ok: false, error: `Unexpected arguments: ${extra.join(" ")}` };

  if (shared) {
    if (slug !== undefined) return { ok: false, error: "Give a slug or --shared, not both." };
    return { ok: true, target: { command: command as Command, slug: null, ...devTestUser(null) } };
  }
  if (slug === undefined) {
    return {
      ok: false,
      error: "Give a slug. The shared test user needs --shared, since other agents may be using it.",
    };
  }
  const valid = validateDevUserSlug(slug);
  if (!valid.ok) {
    const hint = slug === "user" ? " Use --shared for the shared user." : "";
    return { ok: false, error: `Bad slug: ${valid.reason}.${hint}` };
  }
  return { ok: true, target: { command: command as Command, slug, ...devTestUser(slug) } };
}

export interface SeedRow {
  mediaType: "movie" | "tv";
  tmdbId: number;
  status: "watchlist" | "passed" | "seen" | "skipped";
  rating: number | null;
  review: string | null;
}

/**
 * Real TMDB titles, so cards render, two per list and a mix of movies and
 * series. Every row satisfies title_status's checks: a seen row has a
 * half-step rating, only seen rows have a review, and the script gives each
 * skipped row its skip_until.
 */
export const SEED_ROWS: readonly SeedRow[] = [
  { mediaType: "movie", tmdbId: 603, status: "watchlist", rating: null, review: null }, // The Matrix
  { mediaType: "tv", tmdbId: 1396, status: "watchlist", rating: null, review: null }, // Breaking Bad
  { mediaType: "movie", tmdbId: 550, status: "passed", rating: null, review: null }, // Fight Club
  { mediaType: "tv", tmdbId: 1399, status: "passed", rating: null, review: null }, // Game of Thrones
  {
    mediaType: "movie",
    tmdbId: 155, // The Dark Knight
    status: "seen",
    rating: 9,
    review: "Seed review from the walk kit.",
  },
  { mediaType: "tv", tmdbId: 1668, status: "seen", rating: 7, review: null }, // Friends
  { mediaType: "movie", tmdbId: 680, status: "skipped", rating: null, review: null }, // Pulp Fiction
  { mediaType: "tv", tmdbId: 66732, status: "skipped", rating: null, review: null }, // Stranger Things
];
