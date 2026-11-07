import { headers } from "next/headers";
import { cache } from "react";
import { getCurrentUser, type CurrentUser } from "@/core/auth/session";

/**
 * Next.js glue: the signed-in user for the current request, or null. Memoized
 * per request, so the shell layout and the page share one session read.
 */
export const getCurrentUserForRequest = cache(async (): Promise<CurrentUser | null> => {
  return getCurrentUser(await headers());
});
