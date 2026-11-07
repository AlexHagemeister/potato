import type { ReactNode } from "react";
import { getCurrentUserForRequest } from "@/lib/current-user";
import { SignedOutScreen } from "./_shell/signed-out";
import { TabBar } from "./_shell/tab-bar";

// The app shell. It persists across tab switches: Next.js keeps a shared
// layout mounted on client navigation and swaps only the page inside it.
//
// Every tab requires sign-in. Signed out, the whole shell is replaced by the
// sign-in screen. This is not a guard for data: Next.js renders a page in
// parallel with its layout, and the page's output reaches the response even
// when this layout drops it, and the layout does not re-run on client
// navigation. So each page and server action that reads or writes user data
// checks the session itself. Sign-out calls router.refresh(), which re-runs
// this layout.
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUserForRequest();
  if (!user) return <SignedOutScreen />;

  return (
    <div className="fixed inset-0 flex flex-col">
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      <TabBar />
    </div>
  );
}
