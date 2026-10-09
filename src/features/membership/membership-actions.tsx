import { Action, Icon, openExtensionPreferences } from "@raycast/api";
export function MembershipActions({
  authenticated,
  refresh,
}: {
  authenticated: boolean;
  refresh: () => void;
}) {
  return authenticated ? (
    <>
      <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={refresh} />
      <Action
        title="Open Extension Preferences"
        icon={Icon.Gear}
        onAction={openExtensionPreferences}
      />
    </>
  ) : (
    <Action
      title="Open Extension Preferences"
      icon={Icon.Gear}
      onAction={openExtensionPreferences}
    />
  );
}
