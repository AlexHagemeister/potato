import { SignInButton } from "../../auth-buttons";
import { Landing } from "../_landing/landing";

/**
 * The one screen a signed-out visitor sees, whatever the URL: the landing
 * page, which says what Potato is before asking them to sign in (issue 145).
 * The shell layout shows it on a full page load. Each tab page also renders it
 * when signed out, because the layout does not re-run on a tab tap: an expired
 * session would otherwise leave a blank tab under the tab bar. It covers the
 * whole screen, tab bar included.
 *
 * Every signed-out URL gets the same page, a shared title link included: the
 * layout cannot tell which URL it is on, and someone who follows a link to
 * Potato is the person the page is for. Sign-in returns to the deck.
 */
export function SignedOutScreen() {
  return <Landing signIn={<SignInButton />} />;
}
