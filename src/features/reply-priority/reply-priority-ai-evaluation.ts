import {
  AI_PROMPT_VERSION,
  JEV_MODEL,
  classifyAIResult,
  rankAICandidates,
  validAIResult,
  type AIInput,
  type AIResult,
  type ScoreOutcome,
} from "./reply-priority-ai.ts";

export type EvaluationLabel =
  "urgent" | "nonurgent" | "unnecessary" | "ambiguous";
export const EVALUATION_AS_OF = "1791604800.000000";
export const EVALUATION_TIMEZONE = "Asia/Tokyo";
// 人工例文の提案ラベル。本人が出力を見る前に確認・固定するまでは採点に使わない。
export type EvaluationFixture = {
  id: string;
  proposedLabel: EvaluationLabel;
  input: AIInput;
};
const urgent = [
  "今日17時までに承認をお願いします。承認がないと本日のリリースを進められません。",
  "本番障害です。今すぐ担当サービスの状況を回答してください。全処理が停止しています。",
  "提出期限は昨日でした。まだ回答が届いていないので、至急確認結果をください。",
  "あと30分で会議です。資料の数値が正しいか、会議開始までに回答してください。",
  "再度のお願いです。本日中の判断を待っています。これが決まらずチームの作業が止まっています。",
  "お客様が接続できません。すぐに切り戻してよいか回答をお願いします。",
  "17時に申請を締めます。今日の申請対象に含めてよいか16時までに回答してください。",
  "承認待ちで公開作業が停止しています。今すぐ実施可否を回答してください。",
  "大変お忙しいとは思いますが、昨日締切のレビューがまだです。今すぐ可否だけでもください。",
  `${"背景を説明します。今回の変更は表示だけの変更です。".repeat(18)}最後にお願いです。今日16時が期限なので、それまでに承認してください。`,
];
const nonurgent = [
  "来月の勉強会の候補日を教えてください。回答は2週間後までで大丈夫です。",
  "次四半期の改善案について意見をください。今月末までに回答いただければ十分です。",
  "急ぎません。来週後半までにこの資料にコメントをお願いします。作業は先に進められます。",
  "この命名について感想を聞かせてください。期限は設けていません。",
  "来月のイベントに参加できますか？再来週までに回答をお願いします。",
  "そのうち、この改善案に賛成かどうか教えてください。現在の業務への影響はありません。",
  "予算案の確認をお願いします。締切は来月で、現時点の作業は承認なしで進めます。",
  "以前お願いしたアンケートの再案内です。回答期限は2週間後です。急ぐ必要はありません。",
  "来週金曜日までに利用したい研修を教えてください。先に他の準備は進めておきます。",
  "前の至急の依頼は撤回します。改めて来月の候補日を回答してください。今週の回答は不要です。",
];
const unnecessary = [
  "本日のリリースは完了しました。共有のみです。返信は不要です。",
  "資料を更新しました。お時間のあるときに閲覧ください。回答は求めていません。",
  "先ほどの依頼は取り下げます。確認も返信も不要です。",
  "別の担当者が回答してくれたため解決しました。あなたからの回答は不要です。",
  "ご対応ありがとうございました。問題なく動作しました。",
  "明日は休暇を取ります。予定の共有です。返信は不要です。",
  "今日中に、という件は取り消しです。もう確認しなくて大丈夫です。",
  "また素早い回答でしたね（笑）。こちらで解決したので追加の返信は要りません。",
  "障害は復旧しました。状況共有のみで、追加の対応依頼はありません。",
  "議事録を置きました。決定事項の共有のみです。",
  "来週の会議は中止になりました。返信不要です。",
  "ログを添付しておきます。参考情報で、確認依頼ではありません。",
  "先ほどの質問は自分で原因が分かりました。回答不要です。",
  "お知らせ：開発環境を更新しました。利用方法は従来どおりです。",
  "今日の締切については担当Bが対応済みです。あなたの回答は待っていません。",
  "連絡が遅れてすみません。依頼は完了したので何もしなくて大丈夫です。",
  "ただのメモです。次の施策を考えるときに使うかもしれません。",
  "承認待ちは解消しました。今回は私の権限で承認しました。返信不要です。",
  "今すぐ確認してほしいと送りましたが、誤送信でした。無視してください。",
  "いつもありがとうございます。またよろしくお願いします。返信は不要です。",
];
const ambiguous = [
  "例の件、なるはやでお願いします。",
  "そろそろどうでしょうか。例の締切には間に合わせたいです。",
  "このまま進める感じですかね……。",
  "見ておいてもらえると助かるかもです。返事が必要かはまだ決まっていません。",
  "あれって大丈夫そうでしたっけ？何の件かは後で送ります。",
  "お手すきでお願いします。ただ締切が変わるかもしれません。",
  "今度の締め切りまでに回答ください。日程はまだ未定です。",
  "急ぎなのかどうか分からないのですが、確認をお願いするかもしれません。",
  "担当はあなたかBさんか、まだ分かりません。決まったら連絡します。",
  "昨日の話について返信が必要かは確認中です。少しお待ちください。",
];
function fixtures(
  texts: string[],
  label: EvaluationLabel,
  prefix: string,
): EvaluationFixture[] {
  return texts.map((text, index) => {
    const ts = "1791597600.000000";
    return {
      id: `${prefix}${String(index + 1).padStart(2, "0")}`,
      proposedLabel: label,
      input: {
        messages: [{ ts, text: `<@SELF> ${text}`, userId: "OTHER" }],
        rootTs: ts,
        anchorTs: ts,
        selfId: "SELF",
        asOf: EVALUATION_AS_OF,
        timezone: EVALUATION_TIMEZONE,
        evidenceComplete: true,
      },
    };
  });
}
export const EVALUATION_FIXTURES: readonly EvaluationFixture[] = [
  ...fixtures(urgent, "urgent", "U"),
  ...fixtures(nonurgent, "nonurgent", "N"),
  ...fixtures(unnecessary, "unnecessary", "X"),
  ...fixtures(ambiguous, "ambiguous", "A"),
];
export const EVALUATION_PAIR_PROPOSALS: readonly (readonly [string, string])[] =
  [
    ["U01", "N01"],
    ["U02", "N02"],
    ["U03", "N03"],
    ["U04", "N04"],
    ["U05", "N05"],
    ["U06", "N06"],
    ["U07", "N07"],
    ["U08", "N08"],
    ["U09", "N09"],
    ["U10", "N10"],
    ["U02", "N01"],
    ["U03", "N02"],
    ["U05", "N04"],
    ["U08", "N06"],
    ["U10", "N07"],
  ];
export type EvaluationLabels = {
  confirmedBeforeInference: true;
  labels: Readonly<Record<string, EvaluationLabel>>;
  pairs: readonly (readonly [string, string])[];
};
export type QualityGate =
  | { status: "blocked"; reason: string }
  | {
      status: "pass" | "fail";
      checks: {
        needed: number;
        unnecessary: number;
        urgentTop10: number;
        pairs: number;
        ambiguous: number;
        allVisible: boolean;
      };
      model: string;
      promptVersion: string;
    };
export function evaluateQualityGate(
  outcomes: ReadonlyMap<string, ScoreOutcome>,
  labels?: EvaluationLabels,
  fixtures: readonly EvaluationFixture[] = EVALUATION_FIXTURES,
): QualityGate {
  if (!labels?.confirmedBeforeInference)
    return {
      status: "blocked",
      reason: "本人による推論前の期待ラベル・比較ペアの固定が未完了",
    };
  const counts = { urgent: 0, nonurgent: 0, unnecessary: 0, ambiguous: 0 };
  for (const fixture of fixtures) {
    const label = labels.labels[fixture.id];
    if (!Object.hasOwn(counts, label))
      return { status: "blocked", reason: "期待ラベルが不足" };
    counts[label]++;
  }
  if (
    counts.urgent !== 10 ||
    counts.nonurgent !== 10 ||
    counts.unnecessary !== 20 ||
    counts.ambiguous !== 10 ||
    labels.pairs.length !== 15 ||
    new Set(labels.pairs.map(([a, b]) => JSON.stringify([a, b]))).size !== 15 ||
    labels.pairs.some(
      ([a, b]) =>
        !fixtures.some((f) => f.id === a) ||
        !fixtures.some((f) => f.id === b) ||
        !labels.labels[a] ||
        !labels.labels[b] ||
        a === b,
    )
  )
    return {
      status: "blocked",
      reason: "評価集合または15比較ペアが設計条件に不一致",
    };
  const rows = fixtures.map((fixture) => {
    const outcome = outcomes.get(fixture.id);
    return {
      key: fixture.id,
      anchorTs: fixture.input.anchorTs,
      firstUnansweredTs: fixture.input.anchorTs,
      evidenceComplete: true,
      ai: outcome?.kind === "ok" ? outcome.result : undefined,
    };
  });
  const ordered = rankAICandidates(rows);
  const priorities = ordered.filter(
    (row) => classifyAIResult(row.ai).kind === "needed",
  );
  const positions = new Map(ordered.map((row, i) => [row.key, i]));
  function count(
    label: EvaluationLabel,
    kind: ReturnType<typeof classifyAIResult>["kind"],
  ) {
    return rows.filter(
      (row) =>
        labels?.labels[row.key] === label &&
        classifyAIResult(row.ai).kind === kind,
    ).length;
  }
  // API失敗・未判定を曖昧さの正答に数えず、実モデルの判断だけを採点する。
  const ambiguousCorrect = rows.filter(
    (row) =>
      labels.labels[row.key] === "ambiguous" &&
      row.ai &&
      validAIResult(row.ai) &&
      !row.ai.contextIncomplete &&
      ["necessity", "deadline", "confidence"].some((reason) => {
        const decision = classifyAIResult(row.ai);
        return decision.kind === "review" && decision.reason === reason;
      }),
  ).length;
  const checks = {
    needed: count("urgent", "needed") + count("nonurgent", "needed"),
    unnecessary: count("unnecessary", "possibly-unnecessary"),
    urgentTop10: priorities
      .slice(0, 10)
      .filter((row) => labels.labels[row.key] === "urgent").length,
    pairs: labels.pairs.filter(
      ([a, b]) =>
        outcomes.get(a)?.kind === "ok" &&
        outcomes.get(b)?.kind === "ok" &&
        (positions.get(a) ?? Infinity) < (positions.get(b) ?? -Infinity),
    ).length,
    ambiguous: ambiguousCorrect,
    allVisible:
      ordered.length === 50 &&
      new Set(ordered.map((row) => row.key)).size === 50,
  };
  return {
    status:
      checks.needed >= 18 &&
      checks.unnecessary >= 16 &&
      checks.urgentTop10 >= 9 &&
      checks.pairs >= 12 &&
      checks.ambiguous >= 8 &&
      checks.allVisible
        ? "pass"
        : "fail",
    checks,
    model: JEV_MODEL,
    promptVersion: AI_PROMPT_VERSION,
  };
}
export function resultForEvaluation(
  outcome: ScoreOutcome,
): AIResult | undefined {
  return outcome.kind === "ok" ? outcome.result : undefined;
}
