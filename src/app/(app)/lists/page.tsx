import { filterChoiceFromParams, toDeckFilters } from "@/core/filters";
import { getAllLists, listFromParam } from "@/core/lists";
import { getUserSettings } from "@/core/settings/user-settings";
import { getCurrentUserForRequest } from "@/lib/current-user";
import { SignedOutScreen } from "../_shell/signed-out";
import { ListsScreen } from "./lists-screen";

export default async function ListsPage({ searchParams }: PageProps<"/lists">) {
  const user = await getCurrentUserForRequest();
  // Checked here too, not only in the shell layout, which a tab tap does not re-run.
  if (!user) return <SignedOutScreen />;

  // ?list=seen keeps the chosen list across a reload. Anything else opens the Watchlist.
  // The filter parameters (type, genre, era, mine) keep the filters the same way.
  const params = await searchParams;
  const initialList = listFromParam(params.list);
  const filters = filterChoiceFromParams(params);

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
      lists={result.value}
      initialList={initialList}
      filters={filters}
      hasServices={settings.value.providerIds.length > 0}
    />
  );
}
