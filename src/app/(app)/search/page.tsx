import { getCurrentUserForRequest } from "@/lib/current-user";
import { PlaceholderScreen } from "../_shell/placeholder";
import { SignedOutScreen } from "../_shell/signed-out";

export default async function SearchPage() {
  // Checked here too, not only in the shell layout, which a tab tap does not re-run.
  if (!(await getCurrentUserForRequest())) return <SignedOutScreen />;
  return <PlaceholderScreen title="Search" note="Find any movie or series. Coming soon." />;
}
