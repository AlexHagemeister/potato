import { SignInButton } from "../../auth-buttons";

/**
 * The one screen a signed-out visitor sees, whatever the URL. The shell layout
 * shows it on a full page load. Each tab page also renders it when signed out,
 * because the layout does not re-run on a tab tap: an expired session would
 * otherwise leave a blank tab under the tab bar. It covers the whole screen,
 * tab bar included.
 */
export function SignedOutScreen() {
  return (
    <main className="fixed inset-0 z-50 flex bg-background flex-col items-center justify-center gap-10 px-8 pt-[env(safe-area-inset-top)] pb-[calc(env(safe-area-inset-bottom)+2rem)] text-center">
      <div className="flex flex-col items-center gap-3">
        <h1 className="text-5xl font-bold tracking-tight">Potato</h1>
        <p className="text-base text-muted">Decide what to watch, one card at a time.</p>
      </div>
      <SignInButton />
    </main>
  );
}
