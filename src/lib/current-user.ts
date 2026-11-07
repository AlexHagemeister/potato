import { headers } from "next/headers";
import { getCurrentUser, type CurrentUser } from "@/core/auth/session";

/** Next.js glue: the signed-in user for the current request, or null. */
export async function getCurrentUserForRequest(): Promise<CurrentUser | null> {
  return getCurrentUser(await headers());
}
