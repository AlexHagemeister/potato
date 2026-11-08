// The v1 database schema. drizzle-kit generates the SQL migrations in drizzle/
// from this file (bun run db:generate). Never edit an applied migration: change
// this file and generate a new one.
//
// Timestamps are timestamptz everywhere, so values mean the same instant
// whatever the server's time zone.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ---------------------------------------------------------------------------
// Auth tables (Better Auth). Field names (the object keys) are Better Auth's
// own and must not change. Column and table names are ours. The user ID is
// text because Better Auth generates string IDs.
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("accounts_user_id_idx").on(t.userId)],
);

export const verifications = pgTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

// ---------------------------------------------------------------------------
// App tables
// ---------------------------------------------------------------------------

export const MEDIA_TYPES = ["movie", "tv"] as const;
export const TITLE_STATUSES = ["watchlist", "passed", "seen", "skipped"] as const;
export const REVIEW_VISIBILITIES = ["private"] as const;

/**
 * One row per user per title (CLAUDE.md architecture rule 2). The primary key
 * is the identity (user, media type, TMDB ID), so a title can never sit on two
 * lists at once (VISION invariant 3).
 */
export const titleStatus = pgTable(
  "title_status",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mediaType: text("media_type", { enum: MEDIA_TYPES }).notNull(),
    tmdbId: integer("tmdb_id").notNull(),
    status: text("status", { enum: TITLE_STATUSES }).notNull(),
    rating: numeric("rating", { precision: 3, scale: 1, mode: "number" }),
    review: text("review"),
    reviewVisibility: text("review_visibility", { enum: REVIEW_VISIBILITIES })
      .notNull()
      .default("private"),
    skipUntil: timestamp("skip_until", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "title_status_pkey", columns: [t.userId, t.mediaType, t.tmdbId] }),
    index("title_status_user_id_status_idx").on(t.userId, t.status),
    check("title_status_media_type_check", sql`${t.mediaType} in ('movie', 'tv')`),
    check("title_status_tmdb_id_check", sql`${t.tmdbId} > 0`),
    check(
      "title_status_status_check",
      sql`${t.status} in ('watchlist', 'passed', 'seen', 'skipped')`,
    ),
    // The rating scale lives in this one constraint: 0.5 to 10 in half steps.
    check(
      "title_status_rating_scale_check",
      sql`${t.rating} is null or (${t.rating} between 0.5 and 10 and ${t.rating} * 2 = trunc(${t.rating} * 2))`,
    ),
    check(
      "title_status_rating_iff_seen_check",
      sql`(${t.status} = 'seen') = (${t.rating} is not null)`,
    ),
    check("title_status_review_only_seen_check", sql`${t.review} is null or ${t.status} = 'seen'`),
    check("title_status_review_visibility_check", sql`${t.reviewVisibility} in ('private')`),
    check(
      "title_status_skip_until_iff_skipped_check",
      sql`(${t.status} = 'skipped') = (${t.skipUntil} is not null)`,
    ),
  ],
);

/** Per-user settings: country and streaming services. One row per user. */
export const userSettings = pgTable(
  "user_settings",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    // ISO 3166-1 alpha-2, the form TMDB's watch-provider data uses.
    country: text("country").notNull().default("US"),
    // TMDB watch provider IDs.
    providerIds: integer("provider_ids")
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    // Discover's mode and filters (core's DeckChoice), so they follow the user
    // across devices. Core normalizes it on every read: '{}' reads as the
    // default (Blend, no filters).
    deckChoice: jsonb("deck_choice")
      .notNull()
      .default(sql`'{}'::jsonb`),
    updatedAt: updatedAt(),
  },
  (t) => [check("user_settings_country_check", sql`${t.country} ~ '^[A-Z]{2}$'`)],
);

/** IMDb ratings, loaded daily from IMDb's title.ratings.tsv.gz. */
export const imdbRatings = pgTable("imdb_ratings", {
  // IMDb title ID, e.g. 'tt0133093'.
  tconst: text("tconst").primaryKey(),
  averageRating: numeric("average_rating", { precision: 3, scale: 1, mode: "number" }).notNull(),
  numVotes: integer("num_votes").notNull(),
});

/** Cached TMDB responses. The TMDB module owns the key format. */
export const tmdbCache = pgTable(
  "tmdb_cache",
  {
    key: text("key").primaryKey(),
    data: jsonb("data").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("tmdb_cache_expires_at_idx").on(t.expiresAt)],
);
