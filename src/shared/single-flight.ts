// 同じキーの非同期処理を、重ねて実行しない。実行中のものがあれば、新しく始めずに、その結果を待つ。
// @raycast/api を読み込まないので、node のテストから動かせる
export type SingleFlight = <T>(
  key: string,
  task: () => Promise<T>,
) => Promise<T>;

export function createSingleFlight(): SingleFlight {
  const running = new Map<string, Promise<unknown>>();
  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const existing = running.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    // 終わったら（失敗しても）覚えるのをやめる。次の呼び出しは、新しく始める
    const promise = task().finally(() => running.delete(key));
    running.set(key, promise);
    return promise;
  };
}

// 同じ種類の非同期処理を、1つずつ順に実行する。前の処理が終わる（失敗しても）まで、次の処理は始めない。
// 実行の直前に、そのときの状態から計画を立て直せるようにする（先に立てた計画が、前の処理の結果と重ならないように）。
// 例：既読位置の取り直しで、前の回が保存した会話を、次の回は選び直さない
export type Serial = <T>(task: () => Promise<T>) => Promise<T>;

export function createSerial(): Serial {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    // 前が失敗しても、次は始める
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}
