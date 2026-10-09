import assert from "node:assert/strict";
import { test } from "node:test";
import { createSerial, createSingleFlight } from "./single-flight.ts";

// 外から終わらせられる非同期処理。呼ばれた回数も数える
function controlledTask<T>() {
  let calls = 0;
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const task = () => {
    calls += 1;
    return new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
  };
  return {
    task,
    calls: () => calls,
    resolve: (value: T) => resolve(value),
    reject: (error: unknown) => reject(error),
  };
}

test("同じキーを実行中に呼ぶと、新しく始めず、実行中の結果を共有する", async () => {
  const singleFlight = createSingleFlight();
  const first = controlledTask<string>();
  const second = controlledTask<string>();

  const a = singleFlight("people", first.task);
  const b = singleFlight("people", second.task);
  assert.equal(first.calls(), 1);
  assert.equal(second.calls(), 0);

  first.resolve("取得した一覧");
  assert.deepEqual(await Promise.all([a, b]), ["取得した一覧", "取得した一覧"]);
  assert.equal(second.calls(), 0);
});

test("終わったあとの呼び出しは、新しく始める（結果を覚え続けない）", async () => {
  const singleFlight = createSingleFlight();
  const first = controlledTask<number>();
  const a = singleFlight("people", first.task);
  first.resolve(1);
  assert.equal(await a, 1);

  const second = controlledTask<number>();
  const b = singleFlight("people", second.task);
  assert.equal(second.calls(), 1);
  second.resolve(2);
  assert.equal(await b, 2);
});

test("失敗したときは、待っていた全員が同じ失敗を受け取り、次の呼び出しは新しく始める", async () => {
  const singleFlight = createSingleFlight();
  const first = controlledTask<string>();
  const a = singleFlight("people", first.task);
  const b = singleFlight("people", () => Promise.resolve("使われない"));
  const failure = new Error("取得できない");
  first.reject(failure);
  await assert.rejects(a, failure);
  await assert.rejects(b, failure);

  const retry = controlledTask<string>();
  const c = singleFlight("people", retry.task);
  assert.equal(retry.calls(), 1);
  retry.resolve("やり直した");
  assert.equal(await c, "やり直した");
});

test("キーが違えば、重ねて実行する", async () => {
  const singleFlight = createSingleFlight();
  const people = controlledTask<string>();
  const conversations = controlledTask<string>();
  const a = singleFlight("people", people.task);
  const b = singleFlight("conversations", conversations.task);
  assert.equal(people.calls(), 1);
  assert.equal(conversations.calls(), 1);
  people.resolve("人");
  conversations.resolve("会話");
  assert.deepEqual(await Promise.all([a, b]), ["人", "会話"]);
});

test("直列：前の処理が終わるまで、次の処理は始まらない。順に実行し、それぞれの結果を返す", async () => {
  const serial = createSerial();
  const order: string[] = [];
  const first = controlledTask<string>();
  const second = controlledTask<string>();

  const a = serial(() => {
    order.push("first:start");
    return first.task().then((value) => {
      order.push("first:end");
      return value;
    });
  });
  const b = serial(() => {
    order.push("second:start");
    return second.task();
  });
  await Promise.resolve();
  // 1つ目が実行中なので、2つ目はまだ始まらない
  assert.deepEqual(order, ["first:start"]);
  assert.equal(second.calls(), 0);

  first.resolve("1つ目");
  assert.equal(await a, "1つ目");
  await Promise.resolve();
  assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
  second.resolve("2つ目");
  assert.equal(await b, "2つ目");
});

test("直列：前の処理が失敗しても、次の処理は始まる。失敗は、その処理を待っていた側にだけ届く", async () => {
  const serial = createSerial();
  const failure = new Error("取れなかった");
  const a = serial(() => Promise.reject(failure));
  const b = serial(() => Promise.resolve("次は動く"));
  await assert.rejects(a, failure);
  assert.equal(await b, "次は動く");
});

test("直列：あとの処理は、前の処理が終わったあとの状態を見て計画できる（同じ会話を重ねて取らない）", async () => {
  const serial = createSerial();
  const saved = new Set<string>();
  const fetchedBy: string[][] = [];
  // 取る会話を、実行の直前に、保存済みでないものから選ぶ
  const round = (wanted: string[]) =>
    serial(async () => {
      const pick = wanted.filter((id) => !saved.has(id));
      await Promise.resolve();
      for (const id of pick) saved.add(id);
      fetchedBy.push(pick);
      return pick;
    });
  const [a, b] = await Promise.all([
    round(["C1", "C2"]),
    round(["C1", "C2", "C3"]),
  ]);
  assert.deepEqual(a, ["C1", "C2"]);
  // 2回目は、1回目が保存した C1・C2 を取り直さず、新しい C3 だけを取る
  assert.deepEqual(b, ["C3"]);
  assert.deepEqual(fetchedBy, [["C1", "C2"], ["C3"]]);
});
