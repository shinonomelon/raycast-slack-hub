import { environment, getPreferenceValues } from "@raycast/api";
import {
  CONVERSATIONS,
  JOINED,
  PEOPLE,
  directoryIsFresh,
  directoryHasCache,
  directoryStore,
  refreshIfStale,
} from "./directory.ts";
import { fetchIdentity, readIdentity } from "./identity.ts";
import { refreshAll } from "./refresh-all.ts";
import { apiForToken } from "./slack-api-runner.ts";
import { apiWithSource, getApiCredentialKey } from "./request-context.ts";
import {
  configureLanguage,
  readSettings,
  refreshIntervalMs,
} from "../shared/settings.ts";
import { backgroundPreflight } from "./directory-schedule.ts";
import { acquireFileLease } from "./file-lease.ts";
import type { RefreshSchedule } from "./directory-refresh-store.ts";

export default async function Command() {
  configureLanguage();
  const settings = readSettings();
  const background = environment.launchType === "background";
  if (background && settings.backgroundRefreshFrequency === "off") return;
  const api = apiWithSource(
    apiForToken(settings.accessToken, {
      supportPath: environment.supportPath,
      preferences: () => getPreferenceValues<Record<string, unknown>>(),
    }),
    background ? "background" : "directory",
  );
  const credentialKey = getApiCredentialKey(api);
  if (!credentialKey)
    throw new Error("Directory API credential metadata is missing");
  const store = directoryStore();
  const key = `schedule-${credentialKey}`;
  const dirs = [CONVERSATIONS, PEOPLE, JOINED];
  const preflight = () => {
    const schedule = store.read<RefreshSchedule>(key);
    const identity = readIdentity(schedule?.identity);
    return backgroundPreflight({
      background,
      frequency: settings.backgroundRefreshFrequency,
      intervalMs: refreshIntervalMs(settings.backgroundRefreshFrequency),
      now: Date.now(),
      lastStartedAt: schedule?.lastStartedAt,
      identity,
      allPresent:
        !!identity && dirs.every((dir) => directoryHasCache(dir, identity)),
      allFresh:
        !!identity && dirs.every((dir) => directoryIsFresh(dir, identity)),
    });
  };
  if (preflight() !== "run") return;
  const lease = await acquireFileLease(`${store.path(key)}.lock`, 180000);
  if (!lease) return;
  try {
    if (preflight() !== "run") return;
    const startedAt = Date.now();
    await refreshAll({
      fetchIdentity: async () => {
        const outcome = await fetchIdentity(settings, api);
        if (outcome.kind === "ok")
          lease.runIfOwner(() =>
            store.write(key, {
              lastStartedAt: startedAt,
              identity: outcome.identity,
            }),
          );
        return outcome;
      },
      dirs,
      refresh: (dir, identity) => refreshIfStale<unknown>(dir, identity, api),
      log: (line) => console.log(line),
    });
  } finally {
    await lease.release();
  }
}
