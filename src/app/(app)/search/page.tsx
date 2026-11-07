import { getCurrentUserForRequest } from "@/lib/current-user";
import { SignedOutScreen } from "../_shell/signed-out";
import { SearchScreen } from "./search-screen";

// Search: find any title and open its card (VISION: Search). ?q= holds the
// query, so Back from a card and a reload show the same results.
export default async function SearchPage({ searchParams }: PageProps<"/search">) {
  // Checked here too, not only in the shell layout, which a tab tap does not re-run.
  if (!(await getCurrentUserForRequest())) return <SignedOutScreen />;
  const { q } = await searchParams;
  return <SearchScreen initialQuery={typeof q === "string" ? q : ""} />;
}
