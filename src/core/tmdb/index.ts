// The TMDB module (CLAUDE.md architecture rule 4): the only code that talks to TMDB.

export * from "./client";
export * from "./images";
export * from "./types";
export { isPermanentTmdbFailure, TmdbError } from "./http";
export { pickTrailer } from "./normalize";
