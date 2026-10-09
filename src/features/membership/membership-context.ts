import type { Session } from "../../slack/identity.ts";
import type { Names } from "../../slack/names.ts";
import type { Hit } from "../../slack/hits.ts";
import type { Person, Prefs } from "../../shared/types.ts";

export type MembershipContext = {
  session: Session;
  people: readonly Person[];
  prefs: Prefs;
  names: Names;
  isMarked: (hit: Hit) => boolean;
  markOpened: (hit: Hit) => void;
  markReplied: (hit: Hit) => void;
  toggleHandled: (hit: Hit) => void;
};
