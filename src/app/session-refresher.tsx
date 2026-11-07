"use client";

import { useEffect } from "react";
import { authClient } from "@/lib/auth-client";

// Keeps a signed-in user signed in while they use the app. Server components
// read the session but can't set cookies, so a renewed session would never
// reach the browser. This asks /api/auth/get-session once per app open; that
// route handler renews the session (at most once a day) and sends the fresh
// cookie back. Renders nothing.
export function SessionRefresher() {
  useEffect(() => {
    void authClient.getSession();
  }, []);
  return null;
}
