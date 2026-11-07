import { getAllLists } from "@/core/lists";
import { LIST_STATUSES, type ListStatus } from "@/core/types";
import { getCurrentUserForRequest } from "@/lib/current-user";
import { SignedOutScreen } from "../_shell/signed-out";
import { ListsScreen } from "./lists-screen";

export default async function ListsPage({ searchParams }: PageProps<"/lists">) {
  const user = await getCurrentUserForRequest();
  // Checked here too, not only in the shell layout, which a tab tap does not re-run.
  if (!user) return <SignedOutScreen />;

  // ?list=seen keeps the chosen list across a reload. Anything else opens the Watchlist.
  const { list } = await searchParams;
  const initialList = (LIST_STATUSES as readonly unknown[]).includes(list) ? (list as ListStatus) : "watchlist";

  const result = await getAllLists(user.id);
  // A signed-in user whose lists can't load is a broken state. Fail to the tab's error boundary.
  if (!result.ok) throw new Error(`Could not load lists: ${result.error.code}`);

  return <ListsScreen lists={result.value} initialList={initialList} />;
}
