/** The Postgres error code (SQLSTATE) of a database error, looking through Drizzle's wrapper. */
export function pgErrorCode(error: unknown): string | undefined {
  let e: unknown = error;
  for (let depth = 0; e && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** foreign_key_violation: here, a user id with no users row. */
export const FOREIGN_KEY_VIOLATION = "23503";
