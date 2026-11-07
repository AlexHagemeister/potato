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
  const result = await getAuth().api.getSession({ headers });
  if (!result) return null;
  const { id, name, email, image } = result.user;
  return { id, name, email, image: image ?? null };
}
