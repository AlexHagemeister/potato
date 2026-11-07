import { notFound } from "next/navigation";
import { parseTitleKey } from "@/core/title-id";
import { getCurrentUserForRequest } from "@/lib/current-user";
import { PlaceholderScreen } from "../../../_shell/placeholder";
import { SignedOutScreen } from "../../../_shell/signed-out";

// The full card for one title, addressed by its identity pair (CLAUDE.md rule
// 1). A stub: the Lists tab links its rows here, and the card screen builder
// replaces this page with the card and its four buttons.
export default async function TitlePage({ params }: PageProps<"/title/[mediaType]/[tmdbId]">) {
  if (!(await getCurrentUserForRequest())) return <SignedOutScreen />;
  const { mediaType, tmdbId } = await params;
  if (!parseTitleKey(`${mediaType}:${tmdbId}`)) notFound();
  return <PlaceholderScreen title="Title" note="The full card for this title is coming soon." />;
}
