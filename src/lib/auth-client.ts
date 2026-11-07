"use client";

import { createAuthClient } from "better-auth/react";

// Browser-side Better Auth client. Same-origin, so no baseURL: requests go to
// /api/auth on whatever host served the page.
export const authClient = createAuthClient();
