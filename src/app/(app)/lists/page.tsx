import { filterChoiceFromParams, toDeckFilters } from "@/core/filters";
import { getAllLists } from "@/core/lists";
import { getUserSettings } from "@/core/settings/user-settings";
import { getCurrentUserForRequest } from "@/lib/current-user";
import { SignedOutScreen } from "../_shell/signed-out";
import { ListsScreen } from "./lists-screen";

export default async function ListsPage({ searchParams }: PageProps<"/lists">) {
  const user = await getCurrentUserForRequest();
  // Checked here too, not only in the shell layout, which a tab tap does not re-run.
  if (!user) return <SignedOutScreen />;

  // The filter parameters (type, genre, era, imdb, mine) keep the filters across a reload. The list (?list=) is
  // read by the screen from the address, since a tab tap changes it without a server render.
  const filters = filterChoiceFromParams(await searchParams);

  const [result, settings] = await Promise.all([
    getAllLists(user.id, { filters: toDeckFilters(filters, new Date()) }),
    getUserSettings(user.id),
  ]);
  // unknown_user: the session outlived the user row, as on Discover.
  if (!settings.ok && settings.error.code === "unknown_user") return <SignedOutScreen />;
  // A signed-in user whose lists can't load is a broken state. Fail to the tab's error boundary.
  if (!result.ok) throw new Error(`Could not load lists: ${result.error.code}`);
  if (!settings.ok) throw new Error(`Could not load settings: ${settings.error.code}`);

  return (
    <ListsScreen
      // New for each server render. Back restores the router's copy of a render, which keeps its id, so the screen
      // can tell a fresh render from a restored copy (issue 76).
      renderId={crypto.randomUUID()}
      lists={result.value}
      filters={filters}
      hasServices={settings.value.providerIds.length > 0}
    />
  );
}
