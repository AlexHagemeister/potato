"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

const buttonClass =
  "rounded-full bg-white px-6 py-3 text-base font-medium text-black disabled:opacity-60";

export function SignInButton() {
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      className={buttonClass}
      disabled={pending}
      onClick={async () => {
        setPending(true);
        // Redirects the browser to Google; the callback returns to "/".
        const { error } = await authClient.signIn.social({ provider: "google", callbackURL: "/" });
        if (error) setPending(false);
      }}
    >
      Sign in with Google
    </button>
  );
}

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      className={buttonClass}
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await authClient.signOut();
        router.refresh();
        setPending(false);
      }}
    >
      Sign out
    </button>
  );
}
