import {
  Action,
  ActionPanel,
  Alert,
  closeMainWindow,
  confirmAlert,
  Detail,
  Form,
  Icon,
  open,
  popToRoot,
  showToast,
  Toast,
} from "@raycast/api";
import { useMemo, useRef, useState } from "react";
import {
  confirmationOf,
  shouldMarkReplied,
  type SendTarget,
} from "./compose.ts";
import { PEOPLE, useDirectory } from "../../slack/directory.ts";
import type { Session } from "../../slack/identity.ts";
import { mentionCandidates, mentionLabel } from "../../slack/people.ts";
import { postMarkdown } from "./post.ts";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// Slack アプリで開く。開けなかったときは、その理由を返す
async function tryOpen(link: string): Promise<string | undefined> {
  try {
    await open(link);
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

// 会話・人へ投稿するフォーム。一覧の行の Write から開く。
// 会話IDへ投稿し、人宛てはDMを開いてから送る。Slackが返したchannelとtsで投稿の位置を開く。
// メッセージの行の Reply in Thread から開いたときは、thread_tsを指定してスレッドへ返信する。
// 返信が届いたら、返った ts と親の ts で、スレッドの中の返信の位置を開く。
export function ComposeForm({
  session,
  target,
  destination,
  reply,
  onReplied,
}: {
  // 自分の情報。リンクのワークスペースの ID（session.display.teamId）と、メンションの候補（人の一覧）の保存先に使う。
  // 人の一覧を Slack から取るのは、今回の auth.test が成功してから（session.canFetch。useDirectory が判断する）
  session: Session;
  target: SendTarget;
  // 宛先の表示（#名前・@名前）
  destination: string;
  // スレッドへの返信のとき：スレッドの親の ts と、フォームに出す親メッセージの欄の見出しと説明（送信者・時刻・本文の先頭）
  reply?: { threadTs: string; parentTitle: string; parent: string };
  // 返信が届いたときに呼ぶ（元のメッセージの行に「開いた」の印を付ける）。送れたか未確認のとき・失敗したときは呼ばない
  onReplied?: () => void;
}) {
  // 戻ってきても入力が消えないよう、項目はすべてここで持つ
  const [message, setMessage] = useState("");
  const [messageError, setMessageError] = useState<string>();
  const [mentionIds, setMentionIds] = useState<string[]>([]);
  const [isSending, setIsSending] = useState(false);
  // 送れたか未確認になったことがあるか。一度なったら、このフォームでは、1回の ⌘↵ で送り直せる形にしない。
  // 届いていた投稿を送り直すと、同じ投稿が二重になるため。フォームを開き直すまで戻らない
  const [unconfirmed, setUnconfirmed] = useState(false);
  // 送信中の二度押しを無視する。state は次の描画まで変わらず、同じ瞬間に2回押されると止められないので、ref で持つ
  const sending = useRef(false);
  // 送れたか未確認のときに、確かめるために開く先・その操作の名前・送り直しの確認文。
  // 返信ならスレッドの親、それ以外は宛先の会話（決め方は confirmationOf）。トースト・1番目の操作・送り直しの確認で同じものを使う
  const { teamId } = session.display;
  const confirmation = confirmationOf(teamId, target, reply?.threadTs);

  // メンションの候補は、一覧と同じキャッシュから、この画面の中で読む。押した時点の一覧を受け取る形だと、
  // 人の取得中（初回は25秒ほど）に開いたフォームは、取得が終わっても候補が空のままになる。
  // 取得中なら、一覧が始めた取得を待ち、終わったら候補が入る
  const people = useDirectory(PEOPLE, session);
  // ボットを含む全員。数千人になりうるので、入力のたびに作り直さず、候補が変わったときだけ作る
  const mentionItems = useMemo(
    () =>
      mentionCandidates(people.data ?? []).map((p) => (
        <Form.TagPicker.Item key={p.id} title={mentionLabel(p)} value={p.id} />
      )),
    [people.data],
  );

  async function send() {
    if (sending.current || !session.canFetch) return;
    if (message.trim() === "") {
      setMessageError("本文を入力してください");
      return;
    }
    sending.current = true;
    setIsSending(true);
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "投稿しています",
    });

    // 送信には signal を渡さない。送信中にフォームを閉じても最後まで行い、結果はこのトーストで出す
    const outcome = await postMarkdown({
      target,
      mentionIds,
      markdown: message,
      threadTs: reply?.threadTs,
      teamId,
      api: session.api,
    });

    // 返信が届いたら、元のメッセージの行に印を付ける。Slack を開いてウィンドウを閉じる前に、保存まで済ませる。
    // 印を付けられなくても、届いた投稿の結果は変えない（ここで止まると、送り直しで二重に投稿されうる）
    if (shouldMarkReplied(outcome, reply !== undefined)) {
      try {
        onReplied?.();
      } catch {
        // 印は補助。付けられなかっただけ
      }
    }

    if (outcome.kind === "sent") {
      toast.style = Toast.Style.Success;
      toast.title = "投稿しました";
      // 投稿の位置を Slack アプリで開く。開けなくても、投稿は届いている。
      // 送信済みの本文を送り直せないよう、このあとは送信中の状態のままにする
      const openError = await tryOpen(outcome.link);
      if (openError) toast.message = `Slack を開けませんでした（${openError}）`;
      await closeMainWindow({ clearRootSearch: true });
      await popToRoot({ clearSearchBar: true });
      return;
    }

    toast.style = Toast.Style.Failure;
    if (outcome.kind === "unconfirmed") {
      // 届いたかどうかが分からない。失敗と出すと送り直しで二重に投稿されうるので、送り直しは勧めず、
      // 確かめる場所（返信ならスレッドの親、それ以外は宛先の会話）を開けるようにする。本文は消さずに残す。
      // 1番目の操作もその場所を開く操作に替わり、送り直しは確認を挟む別の操作になる（下の actions）
      setUnconfirmed(true);
      toast.title = "送れたか未確認です";
      toast.message = outcome.message;
      toast.primaryAction = {
        title: confirmation.openTitle,
        onAction: async () => {
          const openError = await tryOpen(confirmation.link);
          if (openError) {
            toast.message = `Slack を開けませんでした（${openError}）`;
          }
        },
      };
    } else {
      // Slack が断った・引数の誤りなど、送る前に終わった失敗。入力を残して、直して送り直せるようにする
      toast.title = "投稿に失敗しました";
      toast.message = outcome.message;
    }
    sending.current = false;
    setIsSending(false);
  }

  // 送れたか未確認になったあとの送り直し。前の投稿が届いていると、同じ投稿が二重になるので、確認を挟む。
  // 確認文は、確かめる場所（返信ならスレッドの親、それ以外は宛先の会話）を案内する
  async function sendAgain() {
    if (sending.current || !session.canFetch) return;
    const confirmed = await confirmAlert({
      title: "もう一度送りますか？",
      message: confirmation.resendMessage,
      primaryAction: {
        title: "Send Again",
        style: Alert.ActionStyle.Destructive,
      },
    });
    if (confirmed) await send();
  }

  return (
    <Form
      navigationTitle={
        reply ? `${destination} のスレッドに返信` : `${destination} に書く`
      }
      isLoading={isSending || people.isLoading}
      actions={
        <ActionPanel>
          {/* 未確認のあとは、1番目（⌘↵）を、確かめる場所（返信ならスレッドの親、それ以外は宛先の会話）を開く操作にして、押しただけでは送らない */}
          {unconfirmed && (
            <Action.Open
              title={confirmation.openTitle}
              icon={Icon.ArrowRight}
              target={confirmation.link}
              application="Slack"
            />
          )}
          {unconfirmed ? (
            <Action
              title="Send Again"
              icon={Icon.ArrowClockwise}
              onAction={sendAgain}
            />
          ) : (
            <Action.SubmitForm
              title="Post and Open in Slack"
              icon={Icon.ArrowNe}
              onSubmit={send}
            />
          )}
          <Action.Push
            title="Preview"
            icon={Icon.Eye}
            shortcut={{ modifiers: ["cmd", "shift"], key: "p" }}
            target={
              <Detail
                navigationTitle="プレビュー"
                markdown={message.trim() === "" ? "_（本文なし）_" : message}
              />
            }
          />
        </ActionPanel>
      }
    >
      <Form.Description
        title="宛先"
        text={reply ? `${destination}（スレッドへの返信）` : destination}
      />
      {!session.canFetch && (
        <Form.Description
          title="認証"
          text="認証が完了していないため投稿できません。Slack Access Tokenを確認し、Slack Hubを開き直してください。"
        />
      )}
      {reply && (
        <Form.Description title={reply.parentTitle} text={reply.parent} />
      )}
      <Form.TextArea
        id="message"
        title="本文"
        autoFocus
        enableMarkdown
        placeholder="Markdown で書けます（⌘B 太字・⌘I 斜体・`コード`・- 箇条書き）"
        value={message}
        error={messageError}
        onChange={(value) => {
          setMessage(value);
          if (messageError) setMessageError(undefined);
        }}
      />
      <Form.TagPicker
        id="mentionIds"
        title="メンション"
        placeholder="打つと名前・ハンドルで絞り込み（空ならメンションなし）"
        value={mentionIds}
        onChange={setMentionIds}
      >
        {mentionItems}
      </Form.TagPicker>
    </Form>
  );
}
