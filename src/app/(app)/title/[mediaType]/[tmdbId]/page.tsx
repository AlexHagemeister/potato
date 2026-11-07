import { notFound } from "next/navigation";
import { getCard } from "@/core/deck-service";
import { parseTitleKey } from "@/core/title-id";
import { getCurrentUserForRequest } from "@/lib/current-user";
import { SignedOutScreen } from "../../../_shell/signed-out";
import { TitleScreen } from "./title-screen";

// The full card for one title, addressed by its identity pair (CLAUDE.md rule
// 1): the same card the deck shows, with the same four buttons (VISION:
// Search). Search results and Lists rows open it. Rendered per request, so
// the card always shows the user's current status for the title.
export const dynamic = "force-dynamic";

export default async function TitlePage({ params }: PageProps<"/title/[mediaType]/[tmdbId]">) {
  const user = await getCurrentUserForRequest();
  if (!user) return <SignedOutScreen />;
  const { mediaType, tmdbId } = await params;
  const ref = parseTitleKey(`${mediaType}:${tmdbId}`);
  if (!ref) notFound();

  // getCard throws when TMDB is down: the tab's error boundary offers a retry.
  const result = await getCard(user.id, ref);
  if (!result.ok) {
    if (result.error.code === "unknown_title" || result.error.code === "invalid_title") notFound();
    // The session outlived its user row.
    if (result.error.code === "unknown_user" || result.error.code === "invalid_user") return <SignedOutScreen />;
    throw new Error(`Could not load the card: ${result.error.code}`);
  }
  // Keyed on the title's state: when a refresh finds it changed elsewhere, the screen starts over from the new state.
  return <TitleScreen key={JSON.stringify(result.value.userState)} card={result.value} />;
}
