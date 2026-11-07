import { getAuth } from "./auth";

/** The signed-in user, as app code sees it. */
export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

/**
 * Returns the user whose session cookie is in these request headers, or null
 * when signed out or the session has expired. Callers pass the headers in, so
 * this stays free of framework code (the Next.js glue is src/lib/current-user.ts).
 */
export async function getCurrentUser(headers: Headers): Promise<CurrentUser | null> {
  // disableRefresh: a server render can't set cookies, so a renewal here would
  // move expires_at in the database while the browser cookie kept its old
  // expiry. SessionRefresher's /api/auth/get-session call does the renewal,
  // where the new cookie reaches the browser.
  const result = await getAuth().api.getSession({ headers, query: { disableRefresh: true } });
  if (!result) return null;
  const { id, name, email, image } = result.user;
  return { id, name, email, image: image ?? null };
}
