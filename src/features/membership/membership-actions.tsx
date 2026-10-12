import { t } from "../../shared/i18n.ts";
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
      <Action
        title={t("Refresh")}
        icon={Icon.ArrowClockwise}
        onAction={refresh}
      />
      <Action
        title={t("Open Extension Preferences")}
        icon={Icon.Gear}
        onAction={openExtensionPreferences}
      />
    </>
  ) : (
    <Action
      title={t("Open Extension Preferences")}
      icon={Icon.Gear}
      onAction={openExtensionPreferences}
    />
  );
}
