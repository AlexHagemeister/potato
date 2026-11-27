"use client";

import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";

const buttonClass =
  "rounded-full bg-white px-6 py-3 text-base font-medium text-black disabled:opacity-60";

function ErrorText({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm text-red-400">
      {message}
    </p>
  );
}

export function SignInButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A tap leaves for Google with `pending` still true. If the browser later
  // restores this page from its back/forward cache (Back from Google's
  // consent screen), the page comes back as it was left, button disabled, so
  // re-enable it on a restore (issue 18 item 3). A normal load starts fresh
  // and needs nothing.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) setPending(false);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);
  return (
    <>
      <button
        type="button"
        className={buttonClass}
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          try {
            // Redirects the browser to Google; the callback returns to "/".
            const result = await authClient.signIn.social({ provider: "google", callbackURL: "/" });
            if (result.error) {
              setError("Sign-in didn't start. Try again.");
              setPending(false);
            }
          } catch {
            setError("Sign-in didn't start. Try again.");
            setPending(false);
          }
        }}
      >
        Sign in with Google
      </button>
      <ErrorText message={error} />
    </>
  );
}
