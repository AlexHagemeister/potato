"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      disabled={pending}
      className="mt-4 min-h-11 w-full rounded-xl bg-surface-raised px-4 text-base font-medium text-red-400 disabled:opacity-60"
      onClick={async () => {
        setPending(true);
        const { error } = await authClient.signOut();
        if (error) {
          setPending(false);
          return;
        }
        // Back to the root, so the next sign-in opens on Discover. refresh()
        // re-runs the shell layout, which now shows the sign-in screen.
        router.replace("/");
        router.refresh();
      }}
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
