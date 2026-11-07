import { getProfileSettings } from "@/core/settings/profile";
import { getCurrentUserForRequest } from "@/lib/current-user";
import { Screen, ScreenTitle } from "../_shell/screen";
import { SignedOutScreen } from "../_shell/signed-out";
import { Attribution } from "./attribution";
import { SettingsForm } from "./settings-form";
import { SignOutButton } from "./sign-out-button";

export default async function ProfilePage() {
  const user = await getCurrentUserForRequest();
  // Checked here too, not only in the shell layout, which a tab tap does not re-run.
  if (!user) return <SignedOutScreen />;
  const result = await getProfileSettings(user.id);
  // A signed-in user whose settings can't load is a broken state (a session
  // whose user row is gone). Fail loudly, to the tab's error boundary.
  if (!result.ok) throw new Error(`Could not load settings: ${result.error.code}`);
  const profile = result.value;

  return (
    <Screen>
      <ScreenTitle>Profile</ScreenTitle>

      <section className="mb-8 rounded-2xl bg-surface p-4">
        <p className="text-lg font-semibold">{user.name}</p>
        <p className="text-muted">{user.email}</p>
        <SignOutButton />
      </section>

      <SettingsForm
        initialCountry={profile.settings.country}
        initialProviderIds={profile.settings.providerIds}
        countries={profile.countries}
        initialServices={profile.services}
        servicesUnavailable={profile.servicesUnavailable}
      />

      <Attribution />
    </Screen>
  );
}
