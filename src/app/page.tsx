import { getUserSettings } from "@/core/settings/user-settings";
import { getCurrentUserForRequest } from "@/lib/current-user";
import { SignInButton, SignOutButton } from "./auth-buttons";

// A plain signed-in shell for phase 0. The deck replaces it.
export default async function Home() {
  const user = await getCurrentUserForRequest();
  const settingsResult = user ? await getUserSettings(user.id) : null;
  // A signed-in user whose settings can't load is a broken state (a session
  // whose user row is gone, say). Fail loudly, as this page did before the
  // settings read returned a result instead of throwing.
  if (settingsResult && !settingsResult.ok) {
    throw new Error(`Could not load settings: ${settingsResult.error.code}`);
  }
  const settings = settingsResult?.value ?? null;
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-[max(1rem,env(safe-area-inset-left))] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <h1 className="text-4xl font-semibold tracking-tight">Potato</h1>
      {user && settings ? (
        <>
          <p className="text-lg">Signed in as {user.name}</p>
          <p className="text-sm text-neutral-400">Country: {settings.country}</p>
          <SignOutButton />
        </>
      ) : (
        <SignInButton />
      )}
    </main>
  );
}
