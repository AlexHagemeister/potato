"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
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

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
            const result = await authClient.signOut();
            if (result.error) {
              setError("Sign-out failed. Try again.");
            } else {
              router.refresh();
            }
          } catch {
            setError("Sign-out failed. Try again.");
          }
          setPending(false);
        }}
      >
        Sign out
      </button>
      <ErrorText message={error} />
    </>
  );
}
