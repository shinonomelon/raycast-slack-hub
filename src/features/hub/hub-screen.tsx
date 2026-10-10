import {
  Action,
  ActionPanel,
  Color,
  Icon,
  Keyboard,
  List,
  openExtensionPreferences,
} from "@raycast/api";
import { useFrecencySorting } from "@raycast/utils";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { ComposeForm } from "../compose/compose-form.tsx";
import {
  destinationLabel,
  sendTargetOf,
  targetLink,
} from "../compose/compose.ts";
import { Dictionary } from "../preferences/dictionary.tsx";
import {
  CONVERSATIONS,
  JOINED,
  PEOPLE,
  useDirectory,
} from "../../slack/directory.ts";
import { EditAliases } from "../preferences/edit-item.tsx";
import type { Hit } from "../../slack/hits.ts";
import {
  scopeKey,
  selfHandles,
  sessionOf,
  type IdentityFailure,
  type Session,
} from "../../slack/identity.ts";
import { toFilterSources, toItems } from "../../slack/items.ts";
import type { MembershipContext } from "../membership/membership-context.ts";
import { PersonChannels } from "../membership/person-channels.tsx";
import { ListsScreen } from "../lists/lists-screen.tsx";
import { FEATURE_GATES } from "../operations/feature-gates.ts";
import { BookmarksScreen } from "../bookmarks/bookmarks-screen.tsx";
import { ChannelMembers } from "../membership/channel-members.tsx";
import { rowDetail } from "./row-detail.ts";
import { MessageRow } from "./message-row.tsx";
import { buildNames } from "../../slack/names.ts";
import { listedPeople } from "../../slack/people.ts";
import { loadPrefs, savePrefs } from "../preferences/prefs.ts";
import {
  applyCandidate,
  candidatesFor,
  completingToken,
  orderSources,
  parseQuery,
  resolveQuery,
  type Candidate,
} from "../search/query.ts";
import {
  filterByMembership,
  MEMBERSHIPS,
  orderItems,
  rankItems,
  type Kind,
  type Membership,
} from "../search/search.ts";
import type { SearchStatus } from "../search/search-gate.ts";
import {
  DETAILS_SHORTCUT,
  WRITE_SHORTCUT,
  FILTER_SHORTCUT,
  FILTER_SHORTCUT_ALT,
  RELOAD_ALL_SHORTCUT,
  SWAP_SHORTCUT,
} from "./shortcuts.ts";
import type { ReadState } from "../triage/triage.ts";
import type { Prefs } from "../../shared/types.ts";
import { formatTag } from "../triage/unread-tags.ts";
import { useIdentity } from "../../slack/use-identity.ts";
import { useMessageSearch } from "../search/use-message-search.ts";
import { useTriage } from "../triage/use-triage.ts";
import {
  afterTextChange,
  candidateRowId,
  COMMON_ACTIONS,
  conversationQuery,
  conversationRowId,
  decideSelection,
  filterForHitConversation,
  filterForRow,
  filterForSender,
  messageRowId,
  requestFirstRow,
  sectionOrder,
  standaloneActions,
  STATUS_ROW_ID,
  textWithFilter,
  toggleOverride,
  triageRowId,
  warningRowId,
  type CommonAction,
  type FilterRow,
  type OrderedSection,
  type SelectionRequest,
} from "./view-order.ts";

const ICONS: Record<Kind, Icon> = {
  channel: Icon.Hashtag,
  private: Icon.Lock,
  group: Icon.TwoPeople,
  person: Icon.Person,
};

const CANDIDATE_ICONS: Record<Candidate["kind"], Icon> = {
  ...ICONS,
  self: Icon.PersonCircle,
};

const MEMBERSHIP_TITLES: Record<Membership, string> = {
  all: "すべて",
  joined: "参加中",
  notJoined: "未参加",
};

// 自分用の設定を state とファイルの両方に反映する。
// 押し出した画面からも呼ばれるので、最新の値は ref から読む
function usePrefs() {
  const [prefs, setPrefs] = useState(loadPrefs);
  const latest = useRef(prefs);
  const update = (change: (current: Prefs) => Prefs) => {
    const next = change(latest.current);
    savePrefs(next);
    latest.current = next;
    setPrefs(next);
  };
  return [prefs, update] as const;
}

const firstId = <T,>(rows: readonly T[], idOf: (row: T) => string) =>
  rows.length > 0 ? idOf(rows[0]) : undefined;

// メッセージの検索が、いまの検索語について、止まっている・失敗したときの行。
// 前の検索語の記録は出さない（いまの検索語の結果ではないため）
function searchStatusRow(
  status: SearchStatus | undefined,
  query: string,
  common: ReactNode,
) {
  if (!status || status.query !== query) return null;
  if (status.kind === "paused") {
    return (
      <List.Item
        id={STATUS_ROW_ID}
        icon={{ source: Icon.Clock, tintColor: Color.Orange }}
        title={
          status.pause.cause === "timeout"
            ? "検索が時間切れでした"
            : "Slack の回数制限に当たりました"
        }
        subtitle={`${new Date(status.pause.until).toLocaleTimeString("ja-JP")} まで検索を止めます（そのあと、Reload Searchか入力で検索します）`}
        actions={<ActionPanel>{common}</ActionPanel>}
      />
    );
  }
  if (status.kind === "failed") {
    return (
      <List.Item
        id={STATUS_ROW_ID}
        icon={{ source: Icon.ExclamationMark, tintColor: Color.Red }}
        title="検索に失敗しました"
        subtitle={status.message}
        actions={<ActionPanel>{common}</ActionPanel>}
      />
    );
  }
  return null;
}

// 自分の情報が取れないときの理由の行の id。ほかの行の id（view-order.ts）と重ならない
const IDENTITY_ROW_ID = "identity:failure";

// 拡張の設定を開く操作。自分の情報が取れないときの理由には、どれにもこの操作を付ける
const openPreferencesAction = (
  <Action
    key="open-preferences"
    title="Open Extension Preferences"
    icon={Icon.Gear}
    onAction={openExtensionPreferences}
  />
);

const FAILURE_ICON = { source: Icon.ExclamationMark, tintColor: Color.Red };

// 一覧に出せるものが何も無いとき（前回の自分の情報が無く、今回の auth.test もまだ・取れなかった）の画面。
// 取れなかったときは、理由と、設定を開く操作を出す。Slack のデータは取らない
function NoIdentity({
  failure,
  checking,
}: {
  failure: IdentityFailure | undefined;
  checking: boolean;
}) {
  return (
    <List isLoading={checking}>
      {failure ? (
        <List.EmptyView
          icon={FAILURE_ICON}
          title={failure.title}
          description={failure.message}
          actions={<ActionPanel>{openPreferencesAction}</ActionPanel>}
        />
      ) : (
        <List.EmptyView title="Slack に自分の情報を問い合わせています" />
      )}
    </List>
  );
}

// 開くたびに auth.test で自分の情報（ワークスペースの ID・自分の ID・ハンドル）を取る。
// 前回の結果があれば、その人の保存した一覧をすぐ出す。Slack から取るのは、今回の auth.test が成功してから
// （取得してよいかと、どの人の名前空間を使うかは、decideFetch の結果 decision で決まる。session はそれを渡すだけ）。
// 今回の結果が前回と違う人なら、一覧の部分を作り直して、新しい人の名前空間に切り替える
// （前回の人の一覧や選択が、新しい人の画面に残らないようにする）
export default function Command() {
  const { decision, failure, checking, settings, api } = useIdentity();
  const session = useMemo(() => sessionOf(decision, api), [decision, api]);
  if (!session) {
    return <NoIdentity failure={failure} checking={checking} />;
  }
  return (
    <Hub
      key={scopeKey(session.display)}
      session={session}
      previousHandles={settings.previousHandles}
      failure={failure}
      checking={checking}
    />
  );
}

function Hub({
  session,
  previousHandles,
  failure,
  checking,
}: {
  session: Session;
  // 設定の Previous Handles（カンマ区切り）
  previousHandles: string;
  // 今回の auth.test が取れなかった理由。あれば、一覧の先頭に理由の行を出す（前回の結果の人の一覧は、そのまま出す）
  failure: IdentityFailure | undefined;
  // 今回の auth.test の結果を待っている
  checking: boolean;
}) {
  // 一覧に出す人（前回の結果の人でもよい）。Slack から取るかは session.canFetch で決まり、ここでは判断しない
  const identity = session.display;
  // グループDMの名前から除く、自分のハンドル
  const selfHandleList = useMemo(
    () => selfHandles(identity.user, previousHandles),
    [identity.user, previousHandles],
  );
  // 検索欄は最初から制御する（行の操作で、検索欄の文字を書き換えるため）
  const [searchText, setSearchText] = useState("");
  // Shift+Tab で入れ替えたあとの、先に出すセクション。検索欄を空にしたときと、空欄から打ち始めたときに解除される
  const [override, setOverride] = useState<OrderedSection>();
  // 操作の直後に、先頭の行を1回だけ選ぶ予約。選べたとき・捨てるときに使い終える（decideSelection）
  const [request, setRequest] = useState<SelectionRequest>();
  // 一覧の右のサイドバー（メッセージの本文の全文）を出しているか。開き直すと、閉じた状態から始まる。
  // 出し入れは選択を動かす操作に数えない（予約を作らない）
  const [showDetail, setShowDetail] = useState(false);
  // 人の一覧とは別に持ち、片方の取得がもう片方の表示を待たせないようにする
  const conversations = useDirectory(CONVERSATIONS, session);
  const people = useDirectory(PEOPLE, session);
  const joined = useDirectory(JOINED, session);
  const joinedIds = useMemo(() => new Set(joined.data ?? []), [joined.data]);
  const [prefs, updatePrefs] = usePrefs();
  const membership = prefs.membership;
  const setMembership = (next: Membership) => {
    if (next !== membership) updatePrefs((p) => ({ ...p, membership: next }));
  };

  // 一覧の行に出す人にボットは含めない（メンションの候補には含める。候補は投稿フォームが読む）
  const listed = useMemo(() => listedPeople(people.data ?? []), [people.data]);
  const items = useMemo(
    () => toItems(conversations.data ?? [], listed, prefs, selfHandleList),
    [conversations.data, listed, prefs, selfHandleList],
  );
  const favorites = useMemo(() => new Set(prefs.favorites), [prefs.favorites]);
  // 未読を数えるお気に入り：チャンネル・非公開チャンネル・グループDM。人は含めない（人の未読は、自分宛ての DM で数える）。
  // 一覧にまだ無いもの（読み込み前・削除済み）も含めない。ID の並びが同じなら同じ配列を使う（取り直しのきっかけにしない）
  const favoriteKey = useMemo(() => {
    const kinds = new Map(items.map((item) => [item.id, item.kind]));
    return prefs.favorites
      .filter((id) => {
        const kind = kinds.get(id);
        return kind !== undefined && kind !== "person";
      })
      .join(",");
  }, [items, prefs.favorites]);
  const favoriteIds = useMemo(
    () => (favoriteKey ? favoriteKey.split(",") : []),
    [favoriteKey],
  );
  // 空欄の一覧の自分宛てと、会話の行の未読タグ
  const triage = useTriage({ favoriteIds, session });
  const {
    data: sorted,
    visitItem,
    resetRanking,
  } = useFrecencySorting(items, {
    key: (item) => item.id,
    namespace: "slack-hub",
  });
  // 一致の強さが同じなら、お気に入り → 最近開いた順 → 名前の短い順。
  // 参加中の一覧がまだ無い間は、未参加に全件が出るのを避けるため絞り込み結果を出さない。
  // 絞り込み語（in:・from: など）は会話の一覧の語に含めない
  const shown = useMemo(() => {
    if (membership !== "all" && !joined.data) return [];
    const filtered = filterByMembership(
      // 未読のある会話を上に（未読は裏の取り直しで増減する）
      orderItems(sorted, favorites, triage.unreadIds),
      membership,
      joinedIds,
      // 参加中の絞り込みで残す人（未読の DM がある人）は、開いたときの未読で決める。裏の更新で人の行が消えないように
      triage.openUnread,
    );
    return rankItems(filtered, conversationQuery(searchText));
  }, [
    sorted,
    favorites,
    triage.unreadIds,
    membership,
    joined.data,
    joinedIds,
    triage.openUnread,
    searchText,
  ]);

  // 検索欄の解釈。絞り込みの候補の元は、お気に入り → 最近開いた順に並べて渡す
  // （一致の強さが同じなら、よく使うものが候補の上に来る）
  const sources = useMemo(
    () => orderSources(toFilterSources(sorted, people.data ?? []), favorites),
    [sorted, people.data, favorites],
  );
  const tokenOf = useMemo(() => {
    const tokens = new Map(sources.map((s) => [s.id, s.token]));
    return (id: string) => tokens.get(id);
  }, [sources]);
  const completing = useMemo(
    () => completingToken(parseQuery(searchText)),
    [searchText],
  );
  const candidates = useMemo(
    () =>
      completing ? candidatesFor(completing, sources, identity.userId) : [],
    [completing, sources, identity.userId],
  );
  const resolved = useMemo(
    () => resolveQuery(searchText, sources, identity.userId),
    [searchText, sources, identity.userId],
  );
  const search = useMessageSearch(resolved.query, session);
  // メッセージの行に出す名前は、ボットも含めた全員から引く（投稿者にボットが現れるため）
  const names = useMemo(
    () =>
      buildNames(conversations.data ?? [], people.data ?? [], selfHandleList),
    [conversations.data, people.data, selfHandleList],
  );

  // セクションの順。候補（と、相手が決まらない絞り込みの警告）は、あればいちばん上
  const hasTopSection = candidates.length > 0 || resolved.unresolved.length > 0;
  const order = sectionOrder(searchText, override, hasTopSection);
  // 操作の直後に1回だけ、先頭の行を選ぶ。対象のセクションが、いまの検索語の結果になってから選び、
  // 使い終えたら予約を捨てる。裏の取り直しや並べ替えでは選び直さない（選択が動くと、↵ や ⌘↵ が別の行に効くため）
  const selection = decideSelection(request, {
    text: searchText,
    query: resolved.query,
    search: { query: search.query, status: search.status },
    firstIds: {
      candidates: firstId(candidates, candidateRowId),
      conversations: firstId(shown, conversationRowId),
      messages: firstId(search.hits, messageRowId),
      triage: firstId(triage.rows, ({ hit }) => triageRowId(hit)),
    },
  });
  useEffect(() => {
    if (request && selection.next === undefined) setRequest(undefined);
  }, [request, selection.next]);

  // 変えたあとの文字に、入力中の絞り込み語の候補があるか
  const hasCandidatesFor = (text: string) => {
    const token = completingToken(parseQuery(text));
    return token
      ? candidatesFor(token, sources, identity.userId).length > 0
      : false;
  };

  // 検索欄の文字を変える（打った・Tab で足した・候補を確定した）。文字を変えた直後も、先頭の行を選ぶ予約を作る
  // （afterTextChange）。入れ替えの印は、文字を変えたあとのもので予約を作る（変える前の文字も渡し、
  // 空欄から打ち始めたときに、空欄での入れ替えを持ち越さない）。
  // 待っている間にまた打ったら、予約は新しい文字の分に作り直される。Tab・⌘F・候補の確定もこの関数を通すので、予約を二重に作らない
  const changeSearchText = (text: string) => {
    const next = afterTextChange(
      text,
      override,
      hasCandidatesFor(text),
      searchText,
    );
    setSearchText(text);
    setOverride(next.override);
    setRequest(next.request);
  };

  // この行（会話・人・メッセージの会話や送信者）で絞る。検索欄に足し、新しい検索語のメッセージが先頭に来たら選ぶ。
  // 足す前に外す語は、行の種類で決まる（会話・人の行は、探すのに打った名前も外す。textWithFilter）
  const filterBy = (filter: string, row: FilterRow) =>
    changeSearchText(textWithFilter(searchText, filter, row));

  // 候補を確定する。入力中の語が in:#名前 などに置き換わる
  const confirmCandidate = (candidate: Candidate) => {
    if (!completing) return;
    changeSearchText(applyCandidate(searchText, completing, candidate));
  };

  // Shift+Tab：会話とメッセージ（検索欄が空なら自分宛て）の順を入れ替え、先に出るほうの先頭の行を選ぶ
  const swapOrder = () => {
    const next = toggleOverride(searchText, override);
    setOverride(next);
    setRequest(requestFirstRow(searchText, next, candidates.length > 0));
  };

  // 会話と人の一覧をすべて取り直す
  const reload = () => {
    void conversations.reload();
    void people.reload();
    void joined.reload();
  };

  // ⌘R：表示中の検索に加えて、自分宛て・既読位置・お気に入りの未読も、キャッシュの新しさに関わらず取り直す。
  // 検索を止めている間（search-gate）は取り直さない
  const reloadSearch = () => {
    search.revalidate();
    triage.revalidate();
  };

  const marksRef = useRef(triage.marks);
  marksRef.current = triage.marks;
  const membershipContext: MembershipContext = {
    session,
    people: people.data ?? [],
    prefs,
    names,
    isMarked: (hit) => marksRef.current.has(hit.key),
    markOpened: triage.markOpened,
    markReplied: triage.markReplied,
    toggleHandled: triage.toggleHandled,
  };

  // どの行を選んでいても、一覧が空でも共通操作へ進める。
  // 並べる順は行ごとに決める（actionsIn）。同じ操作を2つ置くとショートカットが重なるので、足さずに、順だけを替える
  const commonAction: Record<CommonAction, ReactElement> = {
    swap: (
      <Action
        key="swap"
        title="Swap Conversations and Messages"
        icon={Icon.Switch}
        shortcut={SWAP_SHORTCUT}
        onAction={swapOrder}
      />
    ),
    "reload-search": (
      <Action
        key="reload-search"
        title="Reload Search"
        icon={Icon.ArrowClockwise}
        shortcut={Keyboard.Shortcut.Common.Refresh}
        onAction={reloadSearch}
      />
    ),
    "reload-all": (
      <Action
        key="reload-all"
        title="Reload Conversations and People"
        icon={Icon.ArrowClockwise}
        shortcut={RELOAD_ALL_SHORTCUT}
        onAction={reload}
      />
    ),
  };
  const actionsIn = (order: readonly CommonAction[]) => [
    ...order.map((name) => commonAction[name]),
    ...(FEATURE_GATES.listsRead
      ? [
          <Action.Push
            key="browse-lists"
            title="Browse Lists"
            icon={Icon.CheckList}
            target={<ListsScreen context={membershipContext} />}
          />,
        ]
      : []),
  ];
  // 行に固有の操作があるときは、その操作のあとに置く
  const commonActions = actionsIn(COMMON_ACTIONS);

  // 詳細を持たない候補・状態の行では、主操作の次に閉じる操作を置く。
  const hideDetails = showDetail ? (
    <Action
      key="hide-details"
      title="Hide Details"
      icon={Icon.Sidebar}
      shortcut={DETAILS_SHORTCUT}
      onAction={() => setShowDetail(false)}
    />
  ) : null;

  // メッセージの行（空欄の自分宛てと検索結果で共通）。id は、同じメッセージが両方に出ても重ならない行の id
  const messageRow = (hit: Hit, id: string, state: ReadState | undefined) => (
    <MessageRow
      key={id}
      session={session}
      id={id}
      hit={hit}
      names={names}
      state={state}
      membershipContext={membershipContext}
      marked={triage.marks.has(hit.key)}
      showDetail={showDetail}
      onToggleDetail={() => setShowDetail((v) => !v)}
      conversationFilter={filterForHitConversation(hit, tokenOf)}
      senderFilter={filterForSender(hit, tokenOf)}
      onFilter={(filter) => filterBy(filter, "message")}
      // Slack で開いた行は読むので、印を付け、その会話の既読位置を忘れる（次に取り直す）。
      // サイドバーで読んだだけでは付けない（onToggleDetail は onOpen を通らない）
      onOpen={() => triage.markOpened(hit)}
      onReplied={() => triage.markReplied(hit)}
      onToggleHandled={() => triage.toggleHandled(hit)}
      common={commonActions}
    />
  );

  const toggleFavorite = (id: string) =>
    updatePrefs((p) => ({
      ...p,
      favorites: p.favorites.includes(id)
        ? p.favorites.filter((f) => f !== id)
        : [...p.favorites, id],
    }));

  const setAliases = (id: string, aliases: string[]) =>
    updatePrefs((p) => {
      const next = { ...p.aliases };
      if (aliases.length) next[id] = aliases;
      else delete next[id];
      return { ...p, aliases: next };
    });

  const conversationNames = useMemo(
    () => items.filter((i) => i.kind !== "person").map((i) => i.title),
    [items],
  );

  const filterLabels = resolved.filters
    .map((f) => `${f.negated ? "-" : ""}${f.modifier}:${f.label}`)
    .join(" ");
  // 検索の停止・失敗の行は、↵ で検索を取り直せるよう、1番目を Reload Search にする
  const standaloneWithDetails = (
    kind: Parameters<typeof standaloneActions>[0],
  ) => {
    const [primary, ...rest] = actionsIn(standaloneActions(kind));
    return [primary, hideDetails, ...rest];
  };
  const statusRow = searchStatusRow(
    search.status,
    resolved.query,
    standaloneWithDetails("search-status"),
  );

  return (
    <List
      isLoading={
        conversations.isLoading ||
        people.isLoading ||
        joined.isLoading ||
        search.isLoading ||
        triage.isLoading ||
        checking
      }
      filtering={false}
      searchText={searchText}
      onSearchTextChange={changeSearchText}
      selectedItemId={selection.selectedId}
      isShowingDetail={showDetail}
      searchBarPlaceholder="チャンネル・人・グループDMを検索（in: from: to: でメッセージを検索）"
      searchBarAccessory={
        <List.Dropdown
          tooltip="参加しているかで絞る"
          value={membership}
          onChange={(value) => setMembership(value as Membership)}
        >
          {MEMBERSHIPS.map((m) => (
            <List.Dropdown.Item
              key={m}
              title={MEMBERSHIP_TITLES[m]}
              value={m}
            />
          ))}
        </List.Dropdown>
      }
    >
      <List.EmptyView
        title={
          membership === "all"
            ? "見つかりません"
            : `${MEMBERSHIP_TITLES[membership]}では見つかりません`
        }
        description="検索欄の右のドロップダウンで、参加中・未参加の絞り込みを切り替えられます"
        actions={<ActionPanel>{standaloneWithDetails("empty")}</ActionPanel>}
      />
      {/* 今回の auth.test が取れなかったとき：理由を一覧の先頭に出す。下の一覧は、前回の結果の人の保存したもの
          （Slack からは取らない）。この行の1番目の操作（↵）は、設定を開く操作。
          行に収まらない長い文は、マウスを載せると全文が出る */}
      {failure ? (
        <List.Section key="identity">
          <List.Item
            id={IDENTITY_ROW_ID}
            icon={FAILURE_ICON}
            title={failure.title}
            subtitle={{ value: failure.message, tooltip: failure.message }}
            actions={
              <ActionPanel>
                {openPreferencesAction}
                {hideDetails}
                {commonActions}
              </ActionPanel>
            }
          />
        </List.Section>
      ) : null}
      {order.map((section) => {
        // 行が1つも無いセクションは出さない（見出しだけが残らないように）
        if (section === "candidates") {
          if (!hasTopSection) return null;
          return (
            <List.Section key="candidates" title="候補">
              {candidates.map((c) => (
                <List.Item
                  key={candidateRowId(c)}
                  id={candidateRowId(c)}
                  icon={CANDIDATE_ICONS[c.kind]}
                  title={c.title}
                  subtitle={`${c.negated ? "-" : ""}${c.modifier}:${c.token}`}
                  actions={
                    <ActionPanel>
                      <Action
                        title="Use This Candidate"
                        icon={Icon.ArrowRight}
                        onAction={() => confirmCandidate(c)}
                      />
                      {hideDetails}
                      {commonActions}
                    </ActionPanel>
                  }
                />
              ))}
              {resolved.unresolved.map((u) => (
                <List.Item
                  key={warningRowId(u.start)}
                  id={warningRowId(u.start)}
                  icon={{ source: Icon.Warning, tintColor: Color.Orange }}
                  title={`「${u.raw}」の相手が決まりません`}
                  subtitle="候補から選ぶか、正式名で打ってください（この絞り込みは送りません）"
                  actions={
                    <ActionPanel>
                      {standaloneWithDetails("unresolved-filter")}
                    </ActionPanel>
                  }
                />
              ))}
            </List.Section>
          );
        }
        if (section === "conversations") {
          if (shown.length === 0) return null;
          return (
            <List.Section key="conversations" title="会話">
              {shown.map((item) => {
                const isFavorite = favorites.has(item.id);
                // 未読の件数（最上位の投稿だけで数える）。下限のときは「3+」
                const unread = triage.tags.get(item.id);
                // 開く先と書く先は同じ。人の行は DM、それ以外は会話
                const target = sendTargetOf(item);
                // この行の会話・人で絞るとき、検索欄に足す文字
                const filter = filterForRow(item, tokenOf);
                const filterTitle =
                  item.kind === "person"
                    ? "Filter by This Person"
                    : "Filter by This Conversation";
                return (
                  <List.Item
                    key={conversationRowId(item)}
                    id={conversationRowId(item)}
                    title={item.title}
                    subtitle={item.subtitle}
                    icon={ICONS[item.kind]}
                    detail={
                      <List.Item.Detail
                        markdown={rowDetail(
                          item,
                          people.data?.find((person) => person.id === item.id),
                        )}
                      />
                    }
                    accessories={[
                      ...(unread
                        ? [
                            {
                              tag: {
                                value: formatTag(unread),
                                color: Color.Red,
                              },
                              tooltip: unread.atLeast
                                ? "未読（件数は下限）"
                                : "未読",
                            },
                          ]
                        : []),
                      ...item.aliases.map((alias) => ({ tag: alias })),
                      ...(isFavorite
                        ? [{ icon: Icon.Star, tooltip: "お気に入り" }]
                        : []),
                    ]}
                    actions={
                      <ActionPanel>
                        <Action.Open
                          title="Open in Slack"
                          icon={Icon.ArrowRight}
                          target={targetLink(identity.teamId, target)}
                          application="Slack"
                          onOpen={() => {
                            // 開いた会話は読むので、タグをすぐ消す（次に既読位置を取り直すまで）
                            triage.markConversationOpened({
                              id: item.id,
                              isPerson: item.kind === "person",
                            });
                            return visitItem(item);
                          }}
                        />
                        <Action
                          title={showDetail ? "Hide Details" : "Show Details"}
                          icon={Icon.Sidebar}
                          shortcut={DETAILS_SHORTCUT}
                          onAction={() => setShowDetail((value) => !value)}
                        />
                        <Action.Push
                          title="Write"
                          icon={Icon.Message}
                          shortcut={WRITE_SHORTCUT}
                          target={
                            <ComposeForm
                              session={session}
                              target={target}
                              destination={destinationLabel(item)}
                            />
                          }
                        />
                        {session.canFetch && item.kind === "person" ? (
                          <Action.Push
                            title="View Channels with This Person"
                            icon={Icon.Hashtag}
                            target={
                              <PersonChannels
                                context={membershipContext}
                                personId={item.id}
                              />
                            }
                          />
                        ) : null}
                        {session.canFetch &&
                        (item.kind === "channel" || item.kind === "private") ? (
                          <Action.Push
                            title="View Members"
                            icon={Icon.TwoPeople}
                            target={
                              <ChannelMembers
                                context={membershipContext}
                                channel={{
                                  id: item.id,
                                  name: item.title,
                                  type:
                                    item.kind === "private"
                                      ? "private"
                                      : "public",
                                }}
                              />
                            }
                          />
                        ) : null}
                        {/* Tab と ⌘F は同じ操作（1つの操作に付けられるショートカットは1つなので、2つ置く） */}
                        {FEATURE_GATES.bookmarksRead &&
                        (item.kind === "channel" || item.kind === "private") ? (
                          <Action.Push
                            title="View Bookmarks"
                            icon={Icon.Bookmark}
                            target={
                              <BookmarksScreen
                                session={session}
                                channel={{ id: item.id, name: item.title }}
                              />
                            }
                          />
                        ) : null}
                        <Action
                          title={filterTitle}
                          icon={Icon.Filter}
                          shortcut={FILTER_SHORTCUT}
                          onAction={() => filterBy(filter, "conversation")}
                        />
                        <Action
                          title={filterTitle}
                          icon={Icon.Filter}
                          shortcut={FILTER_SHORTCUT_ALT}
                          onAction={() => filterBy(filter, "conversation")}
                        />
                        <Action
                          title={
                            isFavorite
                              ? "Remove from Favorites"
                              : "Add to Favorites"
                          }
                          icon={isFavorite ? Icon.StarDisabled : Icon.Star}
                          shortcut={Keyboard.Shortcut.Common.Pin}
                          onAction={() => toggleFavorite(item.id)}
                        />
                        <Action.Push
                          title="Edit Aliases"
                          icon={Icon.Pencil}
                          shortcut={Keyboard.Shortcut.Common.Edit}
                          target={
                            <EditAliases
                              title={item.title}
                              aliases={item.aliases}
                              onSubmit={(aliases) =>
                                setAliases(item.id, aliases)
                              }
                            />
                          }
                        />
                        <Action.Push
                          title="Edit Dictionary"
                          icon={Icon.Book}
                          shortcut={{ modifiers: ["cmd"], key: "d" }}
                          target={
                            <Dictionary
                              rules={prefs.dictionary}
                              names={conversationNames}
                              onChange={(dictionary) =>
                                updatePrefs((p) => ({ ...p, dictionary }))
                              }
                            />
                          }
                        />
                        <Action.CopyToClipboard
                          title="Copy ID"
                          content={item.id}
                          shortcut={Keyboard.Shortcut.Common.Copy}
                        />
                        {commonActions}
                        <Action
                          title="Reset Ranking"
                          icon={Icon.ArrowCounterClockwise}
                          onAction={() => resetRanking(item)}
                        />
                      </ActionPanel>
                    }
                  />
                );
              })}
            </List.Section>
          );
        }
        // 自分宛て：開いたときの判定で未読・スレッド・判定できないもの（新しい順）。検索欄が空のときだけ出る
        if (section === "triage") {
          if (triage.rows.length === 0) return null;
          return (
            <List.Section
              key="triage"
              title="自分宛て（過去7日）"
              subtitle={`${triage.rows.length} 件 · @here・@channel・ユーザーグループ宛ては含まない`}
            >
              {triage.rows.map(({ hit, state }) =>
                messageRow(hit, triageRowId(hit), state),
              )}
            </List.Section>
          );
        }
        // メッセージ：検索結果（新しい順）。止まっている・失敗したときは、そのことを行に出す
        if (!statusRow && search.hits.length === 0) return null;
        return (
          <List.Section
            key="messages"
            title="メッセージ"
            subtitle={
              search.hits.length > 0
                ? [filterLabels, `${search.hits.length} 件`]
                    .filter(Boolean)
                    .join(" · ")
                : undefined
            }
          >
            {statusRow}
            {search.hits.map((hit) =>
              // 検索結果は既読位置を取らない。印が付いているものだけ、対応済みと出す
              messageRow(
                hit,
                messageRowId(hit),
                triage.marks.has(hit.key) ? "handled" : undefined,
              ),
            )}
          </List.Section>
        );
      })}
    </List>
  );
}
