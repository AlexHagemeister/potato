// The IMDb module (CLAUDE.md architecture rule 4): the only code for IMDb ratings.
// App code reads ratings with PostgresRatingsStore and loads them with
// loadImdbRatings({ target: createPostgresRatingsLoadTarget() }).

export * from "./loader";
export * from "./ratings";
export { createPostgresRatingsLoadTarget, PostgresRatingsStore } from "./postgres";
export type { ImdbRatingRow } from "./tsv";
