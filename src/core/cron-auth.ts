// Checks that a request to a cron route comes from Vercel Cron. Vercel sends
// the project's CRON_SECRET as "Authorization: Bearer <CRON_SECRET>".

/**
 * True only when a secret is configured and the header carries exactly
 * "Bearer <secret>". A missing secret rejects everything, so a deploy without
 * CRON_SECRET cannot be triggered by anyone. The comparison takes the same
 * time wherever the strings differ.
 */
export function isAuthorizedCronRequest(authorizationHeader: string | null | undefined, secret: string | undefined): boolean {
  if (!secret || !authorizationHeader) return false;
  return timingSafeEqualStrings(authorizationHeader, `Bearer ${secret}`);
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  // Compare over the longer length so the time does not reveal the expected length's prefix match.
  const len = Math.max(ea.length, eb.length);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < len; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
