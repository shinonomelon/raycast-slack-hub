import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addPerson,
  removePerson,
  intersectChannels,
  targetKey,
} from "./membership.ts";
const channel = (id: string) => ({ id, name: id, type: "public" as const });
test("共通チャンネルはIDでANDし重複を除く", () => {
  assert.deepEqual(
    intersectChannels([
      [channel("C1"), channel("C2"), channel("C2")],
      [channel("C2"), channel("C3")],
    ]),
    [channel("C2")],
  );
  assert.deepEqual(intersectChannels([]), []);
  assert.deepEqual(intersectChannels([[channel("C1")], []]), []);
});
test("重複と6人目を追加せず最後の人を維持する", () => {
  assert.deepEqual(addPerson(["U1"], "U1"), ["U1"]);
  assert.deepEqual(addPerson(["U1"], "U2"), ["U1", "U2"]);
  const ids = ["U1", "U2", "U3", "U4", "U5"];
  assert.deepEqual(addPerson(ids, "U6"), ids);
  assert.deepEqual(removePerson(["U1"], "U1"), ["U1"]);
  assert.deepEqual(removePerson(["U1", "U2"], "U2"), ["U1"]);
  assert.equal(
    targetKey({ kind: "channels", userIds: ["U2", "U1"] }),
    targetKey({ kind: "channels", userIds: ["U1", "U2"] }),
  );
});
