import { getProfileSettings } from "@/core/settings/profile";
import { getCurrentUserForRequest } from "@/lib/current-user";
import { Screen, ScreenTitle } from "../_shell/screen";
import { Attribution } from "./attribution";
import { SettingsForm } from "./settings-form";
import { SignOutButton } from "./sign-out-button";

export default async function ProfilePage() {
  const user = await getCurrentUserForRequest();
  // Signed out: the shell layout already shows the sign-in screen.
  if (!user) return null;
  const profile = await getProfileSettings(user.id);

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
