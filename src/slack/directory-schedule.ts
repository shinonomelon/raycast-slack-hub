import type { Identity } from "./identity.ts";
export function backgroundPreflight(params: {
  background: boolean;
  frequency: string | undefined;
  intervalMs: number;
  now: number;
  lastStartedAt?: number;
  identity?: Identity;
  allFresh: boolean;
  allPresent?: boolean;
}): "off" | "scheduled" | "warm" | "run" {
  if (!params.background) return "run";
  if (params.frequency === "off") return "off";
  const validStart =
    Number.isFinite(params.lastStartedAt) &&
    params.lastStartedAt! <= params.now;
  if (
    params.identity &&
    params.allPresent !== false &&
    validStart &&
    params.now - params.lastStartedAt! < params.intervalMs
  )
    return "scheduled";
  if (params.identity && validStart && params.allFresh) return "warm";
  return "run";
}
