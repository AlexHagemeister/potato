import { ScreenSkeleton } from "./_shell/placeholder";

// Every tab is dynamic (the shell reads the session), so a loading boundary is
// what lets <Link> prefetch a tab partially and switch to it on tap without
// waiting for the server.
export default function Loading() {
  return <ScreenSkeleton />;
}
