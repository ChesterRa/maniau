// 画面とサーバー：見せる物を受け取り、画面の操作を命令で送る。計画はサーバーだけで作り、画面では
// エンジンを動かさない（02-foundation §7.1・§7.2）。家庭は二通り：見る人ごとのデモの家庭（ログイン
// なし。段と使う人を選ぶ）と、家族の家庭（Access でログインした大人。使う人は身元で決まる）。
// 返事の行き違い（遅れた返事・切り替え・途切れ）の扱いは、どちらも同じ（useServerView）。
import type {
  ChangeSummary,
  CheckedIdeas,
  ChoicePreview,
  Command,
  DateTime,
  Household,
  HouseholdPreview,
  MemberDayReply,
  NotificationTitle,
  PlaceAttribution,
  PlanResult,
  PreviewCommand,
  RecordBlock,
  Source,
  SurveyShown,
  TodayCard,
  WayIdeasContext,
} from '@maniau/core';
import type { LiveItem } from '@maniau/core/engine';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Uploadable } from './photo';

/** 家の情報の直しを見た結果：変わること、または直せない理由（サーバーの符号）。 */
export type HouseholdPreviewResult = { preview: HouseholdPreview } | { refused: string };

export interface Stage {
  id: string;
  now: string;
  /** その段で画面を見ている大人（最初に開く人）。 */
  viewer: string;
}

export interface Reading {
  sourceId: string;
  /** recorded：前に録った Claude の応答。expected：手で書いた形。live：家族が入れた文を、いま読んだ。 */
  origin: 'recorded' | 'expected' | 'live';
  model: string;
  /** 家族に確かめてほしい文（読み取れなかった・食い違い・二通りに読める）。 */
  check?: string[];
  /** どの文か分からない問題があった（全体を確かめる）。 */
  checkAll?: boolean;
}

/** 読み取りで、家族に確かめてほしい所。 */
export interface ReadCheck {
  sentenceIds: string[];
  all: boolean;
}

/** サーバーが、その大人のために作った見せる物（apps/server/src/views.ts と同じ形）。 */
export interface SessionView {
  throughSeq: number;
  now: DateTime;
  household: Household;
  plan: PlanResult;
  today: { main: TodayCard[]; quiet: TodayCard[] };
  /** 後から届いたお知らせで変わったこと（二人に同じ物）。 */
  changes?: ChangeSummary;
  sources: Source[];
  /** 出典ごとの読み取り（どのモデルが読んだか、家族に確かめてほしい文）。 */
  readings?: { sourceId: string; model: string; check: string[]; checkAll: boolean }[];
  /** 今の事項。条件しだいの事項には、一つの値で決まる時だけ条件が付く。 */
  items: (LiveItem & { when?: ItemWhen })[];
  /** デモだけ：この時刻の知らせの候補（送らない）。家族の家庭では来ない。 */
  notificationPreview?: NotificationPreview;
}

/** デモの時刻の知らせの候補（apps/server/src/notify-preview.ts と同じ形）。 */
export interface NotificationPreview {
  /** 計画に検証器の違反があり、全部を止めた。 */
  blockedAll: boolean;
  /** 有効な大人の全員（候補が無い大人も入る）。 */
  members: {
    memberId: string;
    /** 今送る候補（二つ以上なら、送る文は件数の文にまとまる）。 */
    now: NotificationTitle[];
    /** 夜なので、朝まで待つ候補と、送ってよい朝の時刻。 */
    morning?: { at: DateTime; titles: NotificationTitle[] };
    /** 検証器が止めた候補の数。 */
    blocked: number;
  }[];
}

/** 条件しだいの事項の条件（一つの未定の値で決まる時。apps/server/src/views.ts と同じ形）。 */
export interface ItemWhen {
  /** 未定の値の名前（お知らせの言葉）。 */
  label: string;
  value: string;
  /** その値でない時に当てはまる。 */
  not?: true;
}

interface Session {
  sessionId: string;
  household: Household;
  readings: Reading[];
  stages: Stage[];
  /** お知らせの文を入れて読めるか（読み取りの鍵があるサーバーだけ）。 */
  canRead?: boolean;
  /** 家族の一言を読めるか（同じく、鍵のあるデモのサーバーだけ）。 */
  canHear?: boolean;
  /** お知らせの写真・PDF を書き起こせるか（同じく）。 */
  canPhoto?: boolean;
  /** 画面で地図を描く鍵（地図のあるデモのサーバーだけ。Maps JavaScript API だけを許した、公開してよい物）。 */
  mapsKey?: string;
  /** 駅の近くの店を地図で探せるか（地図のあるデモのサーバーだけ）。探す言葉の案を Claude に聞けるか。 */
  canSearchStores?: boolean;
  canSuggestStores?: boolean;
  /** 周りの調べ：記録した調べがあるか。Claude にいま調べてもらえるか（Claude の鍵のあるデモのサーバーだけ）。 */
  hasRecordedSurvey?: boolean;
  canSurvey?: boolean;
}

/** 周りの調べの結果（何も書かない。家族が候補を確かめて家の情報に入れる）。 */
export type SurveyRunResult =
  | { status: 'ok'; survey: SurveyShown }
  | { status: 'limit' | 'busy' | 'noRecord' | 'noArea' | 'failed' };

/** 駅の近くで見つけた店（Google の名前・住所・位置は見せるだけ。家庭に残すのは place ID だけ）。 */
export interface FoundStore {
  placeId: string;
  name: string;
  /** 名前・住所と一緒に見せなければならない、データの提供者。 */
  attributions?: PlaceAttribution[];
  address?: string;
  location?: { latitude: number; longitude: number };
  /** 駅からの徒歩（分、切り上げ）。 */
  walkMin: number;
  /** 家庭にもう同じ店がある。 */
  known?: true;
}

/** 店を探した結果。limit：このデモで探せる数を使い切った。 */
export type StoreSearchResult =
  | { status: 'ok'; stores: FoundStore[] }
  | { status: 'limit' | 'failed' };

/**
 * 店までの徒歩の道（デモの地図）。サーバーが Google から引いた名前・位置・道を、見せるだけで取っておかない。
 */
export interface WalkView {
  /** Google に照会した実際の時刻。 */
  checkedAt: string;
  /** attributions：名前と一緒に見せなければならない、データの提供者（駅と店で別々）。 */
  station: {
    id: string;
    name?: string;
    location: { latitude: number; longitude: number };
    attributions?: PlaceAttribution[];
  };
  store: {
    id: string;
    name?: string;
    attributions?: PlaceAttribution[];
    location: { latitude: number; longitude: number };
    googleMapsUri?: string;
  };
  route: { durationSec: number; distanceM: number; polyline?: string; warnings: string[] };
}

/** 家族が入れたお知らせの文。操作 ID は、届いたか分からない時の送り直しに同じ物を使う。 */
export interface NoticeInput {
  text: string;
  sender: string;
  /** 写真・PDF から書き起こし、家族が見比べて直した文なら photo。 */
  medium?: 'text' | 'photo';
  operationId: string;
}

/** 書き起こす写真・PDF（画面で縮めた物）。操作 ID は、返事が届かなかった時の送り直しに同じ物を使う。 */
export type PhotoUpload = Uploadable & { operationId: string };

export type PhotoResult =
  | { status: 'ok'; text: string }
  /**
   * limit：数を使い切った。busy：読んでいる途中。uncertain：返事が届かない（何も記録していない）。
   * tooLarge：大きすぎる・ページが多すぎる（呼んでいない）。
   */
  | { status: 'limit' | 'busy' | 'uncertain' | 'tooLarge' }
  | { status: 'failed'; reason?: string };

export type ReadResult =
  | { status: 'ok'; sourceId: string; check: ReadCheck }
  /**
   * limit：数・量を使い切った。busy：読んでいる途中。uncertain：返事が届かない。stale：読む間に前提が変わった。
   * lost：前に送った同じ操作の結果が、サーバーにも分からない（家族の家庭。同じ操作では送り直さない）。testOnly：
   * 試しの家庭でないので読めない（家族の家庭）。
   */
  | { status: 'limit' | 'busy' | 'uncertain' | 'stale' | 'lost' | 'testOnly' }
  | { status: 'failed'; reason?: string };

/** やり方の案を頼む（W4）。操作 ID は、返事が届かない時の送り直しに同じ物を使う。 */
export interface WayIdeasRequest {
  arrangementKey: string;
  /** 家族の考え（任意）。 */
  text?: string;
  language: 'ja' | 'en';
  operationId: string;
}

export type WayIdeasResult =
  /** sent：Claude に送った物（画面が、送った物として見せる）。何も書いていない。 */
  | { status: 'ok'; ideas: CheckedIdeas; sent: WayIdeasContext }
  /** needGone：「すること」の手配が、もう無いか生きていない。ほかは ReadResult と同じ。 */
  | { status: 'limit' | 'busy' | 'uncertain' | 'stale' | 'lost' | 'testOnly' | 'needGone' }
  | { status: 'failed'; reason?: string };

/** 一言の候補（サーバーが控えを持つ。画面は命令から説明を作る）。 */
export interface ShownProposal {
  id: string;
  command: Command;
  /** 値の答えの候補なら、その問いの名前。 */
  label?: string;
  /**
   * 一言からは記録させない訳（サーバーが core の recordBlock で決める。押されても、サーバーが同じ判断をし直して
   * 断る）。画面は記録の手を出さず、札へ案内する。
   */
  blocked?: RecordBlock;
}

/** 一言の答え（apps/server/src/demo-sessions.ts の ShownReply と同じ形）。 */
export type Heard =
  | { kind: 'change'; proposals: ShownProposal[] }
  | {
      kind: 'clarify';
      proposals: ShownProposal[];
      reason: 'ambiguous' | 'otherAdultsTask' | 'unowned';
      /** 別の大人の作業に加えて、まだだれも持っていない作業も含む。 */
      unowned?: true;
    }
  /** 仮の話：断られたと仮に置く頼み事の候補（返事待ちの物だけ。空なら無い）。何も記録しない。 */
  | { kind: 'whatIf'; requestIds: string[] }
  /** 大人のある一日の話（休む・その時間は家・外出・遅くなる）。何も記録しない（前提の画面で見て、別に押す）。 */
  | { kind: 'memberDay'; day: MemberDayReply }
  | { kind: 'question'; refs: { taskKeys: string[]; requestIds: string[]; itemIds: string[] } }
  | {
      kind: 'unsupported';
      reason: 'routineChange' | 'otherAdultsTask' | 'notInPlan' | 'replyOrWhatIf' | 'other';
    };

export type HearResult =
  /** throughSeq：答えを読んだ時の計画の版（画面は、計画が先へ進んだら古い答えを閉じる）。 */
  | { status: 'ok'; reply: Heard; throughSeq: number }
  /**
   * limit：数を使い切った。busy：読んでいる途中。uncertain：返事が届かない（何も書いていない）。
   * stale：読む間に計画が変わった（もう一度読む）。lost・testOnly は ReadResult と同じ（家族の家庭）。
   */
  | { status: 'limit' | 'busy' | 'uncertain' | 'stale' | 'lost' | 'testOnly' }
  | { status: 'failed'; reason?: string };

/**
 * changed：見せた後に変わった（記録していない）。gone：古い候補。uncertain：届いたか分からない。
 * pending：前の操作が届いたか分からないまま（先にそれを確かめてもらう。順番を入れ替えない）。
 */
export type ConfirmResult = {
  status: 'ok' | 'changed' | 'refused' | 'gone' | 'uncertain' | 'pending' | 'failed';
};

export type SendResult =
  | {
      status: 'ok' | 'noop';
      /** 答えるリンクを出した時だけ、その鍵（応答で一度だけ）。 */
      answerLink?: { personId: string; token: string };
    }
  | { status: 'conflict' | 'forbidden' | 'invalid' | 'failed'; reason?: string };

/**
 * 画面に出す知らせ。changed：見ていた物が古かった（新しい内容で見せ直した）。refused：その操作は
 * できなかった。expired：デモの家庭が古くなった。uncertain：返事が届かず、届いたか分からない
 * （送り直しは、同じ操作 ID で同じ操作として確かめる）。
 */
/** heldByOther：もう一人が担当した（引き受けた・済ませた）作業を、言明で外そうとした（担当した人に確かめる）。 */
export type Notice = 'changed' | 'heldByOther' | 'refused' | 'expired' | 'uncertain';

/**
 * 一つの操作（画面の一回の押下）。送り直す時も、同じ家庭・同じ大人・同じ ID・同じ中身で送る
 * （使う人を替えた後に、前の人の操作を今の人として送らない）。epoch は送った時の画面の代。
 */
interface CommandOperation {
  kind: 'command';
  epoch: number;
  where: Where;
  operationId: string;
  command: Command;
}

/** 一言の候補の記録。命令と同じく、届いたか分からない間は、ほかの書き込みを止める。 */
interface ProposalOperation {
  kind: 'proposal';
  epoch: number;
  where: Where;
  proposalId: string;
  operationId: string;
}

type Operation = CommandOperation | ProposalOperation;

/** 見せる物を読み、命令を送る先。 */
export type Where =
  | { kind: 'demo'; sessionId: string; memberId: string }
  | { kind: 'family'; memberId: string };

// 家族の家庭では、画面が見ている大人（as）を添える。今の身元と違えば、サーバーは家庭の物を返さない
// （別の画面でログインが替わった時、前の人の画面のまま次の人として読む・書くのを防ぐ）。
const viewUrl = (w: Where) =>
  w.kind === 'demo'
    ? `/api/demo/sessions/${w.sessionId}/view?member=${encodeURIComponent(w.memberId)}`
    : `/api/view?as=${encodeURIComponent(w.memberId)}`;
const commandUrl = (w: Where) =>
  w.kind === 'demo' ? `/api/demo/sessions/${w.sessionId}/commands` : '/api/commands';
// 家族の家庭では、操作する人をサーバーが身元から決める。as は比べるためだけ（権限には使わない）。
const commandBody = (w: Where, operationId: string, command: Command) =>
  w.kind === 'demo'
    ? { memberId: w.memberId, operationId, command }
    : { as: w.memberId, operationId, command };
/** 身元を確かめられない・家族の大人でない（家族の家庭だけ）。 */
const DENIED = new Set(['unauthenticated', 'notAMember']);
// 読み取り（お知らせ・一言）と一言の候補の記録の送り先と本文。家族の家庭は as を添える（比べるためだけ）。
const inputUrl = (w: Where, path: 'notices' | 'utterances' | 'way-ideas') =>
  w.kind === 'demo' ? `/api/demo/sessions/${w.sessionId}/${path}` : `/api/${path}`;
const proposalUrl = (w: Where, proposalId: string) =>
  w.kind === 'demo'
    ? `/api/demo/sessions/${w.sessionId}/proposals/${encodeURIComponent(proposalId)}`
    : `/api/proposals/${encodeURIComponent(proposalId)}`;
const inputBody = (w: Where, payload: Record<string, unknown>) =>
  w.kind === 'demo' ? { memberId: w.memberId, ...payload } : { as: w.memberId, ...payload };
/**
 * 読み取りの断りの種類から、画面の結果へ（デモと家族の家庭で共通。家族の家庭だけの物も含む）。記録の途中の失敗
 * （store）は、足したか分からないので uncertain（同じ操作のまま確かめる）。モデルの失敗などは、何も足していないので
 * failed（家族が押し直せば新しい操作）。
 */
function readRefusal(
  error: string,
  reason?: string,
): { status: 'limit' | 'busy' | 'stale' | 'lost' | 'testOnly' | 'uncertain' } | undefined {
  if (error === 'readingFailed' && reason === 'store') return { status: 'uncertain' };
  switch (error) {
    case 'readingLimit':
      return { status: 'limit' };
    case 'readingBusy':
      return { status: 'busy' };
    case 'readingStale':
      return { status: 'stale' };
    case 'readingUncertain':
      return { status: 'lost' };
    case 'testHouseholdOnly':
      return { status: 'testOnly' };
    default:
      return undefined;
  }
}

const json = { 'content-type': 'application/json' };
/** 命令の返事を待つ長さ。過ぎたら「届いたか分からない」にする（同じ ID で送り直せる）。 */
const COMMAND_TIMEOUT_MS = 20_000;
/** 読み取りの返事を待つ長さ（Claude が読むので、命令より長い）。 */
const READ_TIMEOUT_MS = 120_000;
/** Claude がいま周りを調べる時の待ち（検索と頁の読み取りを何度かするので、読み取りより長い）。 */
const SURVEY_TIMEOUT_MS = 300_000;

/** 操作 ID（同じ操作の送り直しを見分ける。§7.3 の 4）。 */
export function operationId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

/** 見せる物と、それを読んだ画面の代（別の人・前の代の物を、今の画面に出さないため）。 */
interface Shown {
  epoch: number;
  view: SessionView;
}

/**
 * 画面の代：家庭（段・やり直し）か使う人が替わるたびに増える。A→B→A と戻っても、前の A の代とは
 * 別にする（名前が同じでも、替える前に送った物の返事を、今の画面に使わない）。
 */
interface Current {
  key: string | undefined;
  memberId: string | undefined;
  epoch: number;
}

/**
 * 見せる物を読み、命令を送る（デモと家族の家庭で共通）。where が替わる（家庭・使う人）たびに代を
 * 進め、前の代の返事を使わない。同じ代では、通し番号の古い見せる物で新しい物を上書きしない。
 */
export function useServerView(where: Where | undefined) {
  const [shown, setShown] = useState<Shown>();
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  // ログインの身元が、画面の大人と替わった（家族の家庭だけ）。画面は身元を確かめ直す。
  const [switched, setSwitched] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const [reload, setReload] = useState(0);
  // 返事を待っている操作の代（同じ代の二度押しを止める。替えた後の人の操作は止めない）。
  const busy = useRef<number | undefined>(undefined);
  // 届いたか分からない操作。新しい操作を送る前に、これを同じ ID で確かめる。
  const pending = useRef<Operation | undefined>(undefined);
  const current = useRef<Current>({ key: undefined, memberId: undefined, epoch: 0 });

  // 効果の依存は文字だけにする（where の物は描画ごとに作り直される）。
  const kind = where?.kind;
  const sessionId = where?.kind === 'demo' ? where.sessionId : undefined;
  const memberId = where?.memberId;
  const key = kind === undefined ? undefined : `${kind}:${sessionId ?? ''}`;
  // 替わったら、すぐ（描画の中で）代を進める。遅れて届く返事は、どの await の後でも代で確かめる。
  if (current.current.key !== key || current.current.memberId !== memberId) {
    current.current = { key, memberId, epoch: current.current.epoch + 1 };
  }
  const epoch = current.current.epoch;
  const isCurrent = useCallback((at: number) => current.current.epoch === at, []);
  // 見せる物を替える。同じ代の中では、通し番号の古い物で新しい物を上書きしない（遅れて届いた
  // 読み直しが、後の命令の返事を消さないように）。
  const show = useCallback((at: number, view: SessionView) => {
    setShown((previous) =>
      previous && previous.epoch === at && previous.view.throughSeq > view.throughSeq
        ? previous
        : { epoch: at, view },
    );
    // 読めたので、前に読めなかった知らせは消す。
    setFailed(false);
  }, []);

  // 代が替わったら、前の代の届いたか分からない操作と知らせは手放す（今の人には関係しない）。
  useEffect(() => {
    void epoch;
    pending.current = undefined;
    setNotice(undefined);
  }, [epoch]);
  // 別のタブ（相手の答える頁など）から戻った時は、見せる物を読み直す（その間に、だれかの答えが届いているかも
  // しれない。読むだけで、何も書かない）。
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') setReload((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
  // 使う人を替えたら（届いたか分からない時も）、その人の見せる物を読み直す。
  useEffect(() => {
    void reload;
    if (!kind || !memberId) return;
    if (kind === 'demo' && !sessionId) return;
    const target: Where =
      kind === 'demo' ? { kind, sessionId: sessionId ?? '', memberId } : { kind, memberId };
    const at = current.current.epoch;
    let cancelled = false;
    const usable = () => !cancelled && isCurrent(at);
    fetch(viewUrl(target))
      .then(async (response) => {
        if (response.status === 401 || response.status === 403) {
          if (usable()) setDenied(true);
          return;
        }
        if (response.status === 409 && target.kind === 'family') {
          if (usable()) setSwitched(true);
          return;
        }
        if (response.status === 404 && target.kind === 'demo') {
          if (usable()) setNotice('expired');
          return;
        }
        if (!response.ok) throw new Error(String(response.status));
        const next = (await response.json()) as SessionView;
        if (usable()) show(at, next);
      })
      .catch(() => {
        if (usable()) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, sessionId, memberId, reload, isCurrent, show]);

  const deliver = useCallback(
    async (operation: CommandOperation): Promise<SendResult> => {
      const { epoch: at, where: target, operationId, command } = operation;
      // 待つ間（中身を読む間も）に、段・やり直し・使う人が替わっていたら（替えて戻った時も）、この
      // 返事は使わず、前の画面の続き（移る等）もさせない。今の画面は読み直す。
      const stale = (): SendResult => {
        setReload((n) => n + 1);
        return { status: 'failed', reason: 'stale' };
      };
      // 二度押しで、同じ操作を別の操作として送らない。
      if (busy.current === at) return { status: 'failed', reason: 'busy' };
      busy.current = at;
      try {
        const response = await fetch(commandUrl(target), {
          method: 'POST',
          headers: json,
          body: JSON.stringify(commandBody(target, operationId, command)),
          signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
        });
        if (response.status === 404 && target.kind === 'demo') {
          if (pending.current?.operationId === operationId) pending.current = undefined;
          if (!isCurrent(at)) return stale();
          setNotice('expired');
          return { status: 'failed', reason: 'unknownSession' };
        }
        const body = (await response.json()) as
          | { result: SendResult & { throughSeq: number }; view: SessionView }
          | { error: string };
        // 返事が届いたので、この操作の結果は分かった。
        if (pending.current?.operationId === operationId) pending.current = undefined;
        if (!isCurrent(at)) return stale();
        if (!('result' in body)) {
          if (DENIED.has(body.error)) setDenied(true);
          else if (body.error === 'identityChanged') setSwitched(true);
          else setNotice('refused');
          return { status: 'invalid', reason: body.error };
        }
        // 断られても、返った新しい見せる物で見せ直す。
        show(at, body.view);
        const { status } = body.result;
        if (status === 'conflict') {
          setNotice(body.result.reason === 'heldByOther' ? 'heldByOther' : 'changed');
        } else if (status === 'forbidden' || status === 'invalid') setNotice('refused');
        else setNotice(undefined);
        return body.result;
      } catch {
        // 返事が届かなかった（待ちすぎも含む）。サーバーが受け付けたかもしれないので「送れなかった」
        // とは言わない。同じ操作を取っておき、送り直しは同じ ID で行う（別の操作として二度書かない）。
        // 代が替わっていたら、前の人の操作は取っておかない（今の人として送らない）。
        if (!isCurrent(at)) return stale();
        setReload((n) => n + 1);
        pending.current = operation;
        setNotice('uncertain');
        return { status: 'failed', reason: 'uncertain' };
      } finally {
        if (busy.current === at) busy.current = undefined;
      }
    },
    [isCurrent, show],
  );

  const send = useCallback(
    (command: Command): Promise<SendResult> => {
      const now = current.current;
      // 前の描画の押下（今の人と違う人のまま）を、今の人の操作として送らない。
      if (!kind || !memberId || now.key !== key || now.memberId !== memberId) {
        return Promise.resolve({ status: 'failed', reason: 'stale' });
      }
      if (kind === 'demo' && !sessionId) return Promise.resolve({ status: 'failed' });
      // 届いたか分からない操作が残っていれば、先にそれを確かめてもらう。
      if (pending.current) {
        setNotice('uncertain');
        return Promise.resolve({ status: 'failed', reason: 'uncertain' });
      }
      const target: Where =
        kind === 'demo' ? { kind, sessionId: sessionId ?? '', memberId } : { kind, memberId };
      return deliver({
        kind: 'command',
        epoch: now.epoch,
        where: target,
        operationId: operationId(),
        command,
      });
    },
    [deliver, kind, key, sessionId, memberId],
  );

  /**
   * お知らせの文を入れて読む（デモの家庭と、家族の試しの家庭）。読めたら、返った新しい見せる物で見せ直す。
   * 待つ間に段・使う人が替わっていたら、その返事は使わない。家族の家庭は、写真の書き起こしの印を送らない
   * （まだ開けない）。
   */
  const read = useCallback(
    async (input: NoticeInput): Promise<ReadResult> => {
      const now = current.current;
      if (!kind || !memberId || now.key !== key || (kind === 'demo' && !sessionId)) {
        return { status: 'failed', reason: 'stale' };
      }
      if (now.memberId !== memberId) return { status: 'failed', reason: 'stale' };
      if (kind === 'family' && input.medium === 'photo') {
        return { status: 'failed', reason: 'photoUnavailable' };
      }
      const target: Where =
        kind === 'demo' ? { kind, sessionId: sessionId ?? '', memberId } : { kind, memberId };
      if (busy.current === now.epoch) return { status: 'busy' };
      busy.current = now.epoch;
      try {
        const { medium, ...rest } = input;
        const response = await fetch(inputUrl(target, 'notices'), {
          method: 'POST',
          headers: json,
          body: JSON.stringify(
            inputBody(target, kind === 'demo' && medium ? { ...rest, medium } : rest),
          ),
          signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        });
        if (!isCurrent(now.epoch)) {
          setReload((n) => n + 1);
          return { status: 'failed', reason: 'stale' };
        }
        if (response.status === 404 && target.kind === 'demo') {
          setNotice('expired');
          return { status: 'failed', reason: 'unknownSession' };
        }
        const body = (await response.json()) as
          | { view: SessionView; sourceId: string; check: ReadCheck }
          | { error: string; reason?: string };
        if (!isCurrent(now.epoch)) {
          setReload((n) => n + 1);
          return { status: 'failed', reason: 'stale' };
        }
        if ('view' in body) {
          show(now.epoch, body.view);
          return { status: 'ok', sourceId: body.sourceId, check: body.check };
        }
        if (DENIED.has(body.error)) setDenied(true);
        else if (body.error === 'identityChanged') setSwitched(true);
        const refusal = readRefusal(body.error, body.reason);
        // 前の操作の結果が分からない：足したかもしれないので、見せる物を読み直す。
        if (refusal?.status === 'lost' || refusal?.status === 'uncertain') setReload((n) => n + 1);
        return refusal ?? { status: 'failed', reason: body.reason ?? body.error };
      } catch {
        // 返事が届かなかった。読んで足したかもしれないので、読み直して確かめる。
        if (isCurrent(now.epoch)) setReload((n) => n + 1);
        return { status: 'uncertain' };
      } finally {
        if (busy.current === now.epoch) busy.current = undefined;
      }
    },
    [kind, key, sessionId, memberId, isCurrent, show],
  );

  /**
   * デモの家庭で、お知らせの写真・PDF を書き起こす。文を返すだけで何も書かない（写真も残さない）。家族が
   * 写真と見比べて直してから、read で読む。待つ間に段・使う人が替わっていたら、その返事は使わない。
   */
  const transcribe = useCallback(
    async (input: PhotoUpload): Promise<PhotoResult> => {
      const now = current.current;
      if (kind !== 'demo' || !sessionId || !memberId || now.key !== key) {
        return { status: 'failed', reason: 'stale' };
      }
      if (now.memberId !== memberId) return { status: 'failed', reason: 'stale' };
      if (busy.current === now.epoch) return { status: 'busy' };
      busy.current = now.epoch;
      try {
        const response = await fetch(`/api/demo/sessions/${sessionId}/photos`, {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ memberId, ...input }),
          signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        });
        if (!isCurrent(now.epoch)) return { status: 'failed', reason: 'stale' };
        if (response.status === 404) {
          setNotice('expired');
          return { status: 'failed', reason: 'unknownSession' };
        }
        // 大きすぎて断られた時は、途中の中継が返した物（JSON でない）でも、そう示す。
        if (response.status === 413) return { status: 'tooLarge' };
        const body = (await response.json()) as { text: string } | { error: string };
        if (!isCurrent(now.epoch)) return { status: 'failed', reason: 'stale' };
        if ('text' in body) return { status: 'ok', text: body.text };
        if (body.error === 'readingLimit') return { status: 'limit' };
        if (body.error === 'readingBusy') return { status: 'busy' };
        return { status: 'failed', reason: body.error };
      } catch {
        return { status: 'uncertain' };
      } finally {
        if (busy.current === now.epoch) busy.current = undefined;
      }
    },
    [kind, key, sessionId, memberId, isCurrent],
  );

  /**
   * 家族の一言を読む（デモの家庭と、家族の試しの家庭）。読むだけで何も書かないので、返事が届かなくても
   * 同じ操作 ID で送り直せる。待つ間に段・使う人が替わっていたら、その返事は使わない。
   */
  const hear = useCallback(
    async (text: string, op: string): Promise<HearResult> => {
      const now = current.current;
      if (!kind || !memberId || now.key !== key || (kind === 'demo' && !sessionId)) {
        return { status: 'failed', reason: 'stale' };
      }
      if (now.memberId !== memberId) return { status: 'failed', reason: 'stale' };
      const target: Where =
        kind === 'demo' ? { kind, sessionId: sessionId ?? '', memberId } : { kind, memberId };
      if (busy.current === now.epoch) return { status: 'busy' };
      busy.current = now.epoch;
      try {
        const response = await fetch(inputUrl(target, 'utterances'), {
          method: 'POST',
          headers: json,
          body: JSON.stringify(inputBody(target, { operationId: op, text })),
          signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        });
        const body = (await response.json()) as
          | { view: SessionView; reply: Heard }
          | { error: string; reason?: string };
        if (!isCurrent(now.epoch)) {
          setReload((n) => n + 1);
          return { status: 'failed', reason: 'stale' };
        }
        if ('view' in body) {
          show(now.epoch, body.view);
          return { status: 'ok', reply: body.reply, throughSeq: body.view.throughSeq };
        }
        if (body.error === 'unknownSession') {
          setNotice('expired');
          return { status: 'failed', reason: 'unknownSession' };
        }
        if (DENIED.has(body.error)) setDenied(true);
        else if (body.error === 'identityChanged') setSwitched(true);
        return (
          readRefusal(body.error, body.reason) ?? {
            status: 'failed',
            reason: body.reason ?? body.error,
          }
        );
      } catch {
        return { status: 'uncertain' };
      } finally {
        if (busy.current === now.epoch) busy.current = undefined;
      }
    },
    [kind, key, sessionId, memberId, isCurrent, show],
  );

  /**
   * 「すること」に、Claude がやり方の案を出す（デモの家庭と、家族の試しの家庭）。何も書かないので、見せる物は
   * 替えない。待つ間に段・使う人が替わっていたら、その返事は使わない。
   */
  const wayIdeas = useCallback(
    async (input: WayIdeasRequest): Promise<WayIdeasResult> => {
      const now = current.current;
      if (!kind || !memberId || now.key !== key || (kind === 'demo' && !sessionId)) {
        return { status: 'failed', reason: 'stale' };
      }
      if (now.memberId !== memberId) return { status: 'failed', reason: 'stale' };
      const target: Where =
        kind === 'demo' ? { kind, sessionId: sessionId ?? '', memberId } : { kind, memberId };
      if (busy.current === now.epoch) return { status: 'busy' };
      busy.current = now.epoch;
      try {
        const response = await fetch(inputUrl(target, 'way-ideas'), {
          method: 'POST',
          headers: json,
          body: JSON.stringify(inputBody(target, { ...input })),
          signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        });
        const body = (await response.json()) as
          | { ideas: CheckedIdeas; sent: WayIdeasContext }
          | { error: string; reason?: string };
        if (!isCurrent(now.epoch)) return { status: 'failed', reason: 'stale' };
        if ('ideas' in body) return { status: 'ok', ideas: body.ideas, sent: body.sent };
        if (body.error === 'unknownSession') {
          setNotice('expired');
          return { status: 'failed', reason: 'unknownSession' };
        }
        if (DENIED.has(body.error)) setDenied(true);
        else if (body.error === 'identityChanged') setSwitched(true);
        if (body.error === 'needGone') return { status: 'needGone' };
        return (
          readRefusal(body.error, body.reason) ?? {
            status: 'failed',
            reason: body.reason ?? body.error,
          }
        );
      } catch {
        return { status: 'uncertain' };
      } finally {
        if (busy.current === now.epoch) busy.current = undefined;
      }
    },
    [kind, key, sessionId, memberId, isCurrent],
  );

  /**
   * 一言の候補の記録を送る（送り直しも同じ ID で）。サーバーが、見せた時と今の対象の状態を比べ、違えば
   * 記録しない。返事が届かない時は、記録したか分からないので、命令と同じく取っておき（確かめるまで、
   * ほかの書き込みを送らない）、見せる物を読み直す（同じ ID の送り直しは二度記録しない）。
   */
  const deliverProposal = useCallback(
    async (operation: ProposalOperation): Promise<ConfirmResult> => {
      const { epoch: at, operationId: op } = operation;
      if (busy.current === at) return { status: 'failed' };
      busy.current = at;
      try {
        const response = await fetch(proposalUrl(operation.where, operation.proposalId), {
          method: 'POST',
          headers: json,
          body: JSON.stringify(inputBody(operation.where, { operationId: op })),
          signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
        });
        const body = (await response.json()) as { view?: SessionView; error?: string };
        // 返事が届いたので、この操作の結果は分かった。
        if (pending.current?.operationId === op) pending.current = undefined;
        if (!isCurrent(at)) {
          setReload((n) => n + 1);
          return { status: 'failed' };
        }
        if (body.view) show(at, body.view);
        if (response.ok) return { status: 'ok' };
        if (body.error === 'unknownSession') {
          setNotice('expired');
          return { status: 'failed' };
        }
        if (body.error !== undefined && DENIED.has(body.error)) {
          setDenied(true);
          return { status: 'failed' };
        }
        if (body.error === 'identityChanged') {
          setSwitched(true);
          return { status: 'failed' };
        }
        if (body.error === 'proposalChanged') return { status: 'changed' };
        if (body.error === 'unknownProposal') return { status: 'gone' };
        return { status: 'refused' };
      } catch {
        if (!isCurrent(at)) {
          setReload((n) => n + 1);
          return { status: 'failed' };
        }
        setReload((n) => n + 1);
        pending.current = operation;
        setNotice('uncertain');
        return { status: 'uncertain' };
      } finally {
        if (busy.current === at) busy.current = undefined;
      }
    },
    [isCurrent, show],
  );

  /** 一言の候補を記録する（押すごとに新しい操作。届いたか分からない操作が残る間は送らない）。 */
  const confirm = useCallback(
    async (proposalId: string, op: string): Promise<ConfirmResult> => {
      const now = current.current;
      if (!kind || !memberId || now.key !== key || (kind === 'demo' && !sessionId)) {
        return { status: 'failed' };
      }
      if (now.memberId !== memberId) return { status: 'failed' };
      // 届いたか分からない操作が残っていれば、先にそれを確かめてもらう（後から届いた前の操作が、
      // この記録を上書きしないように。命令の送り方と同じ）。
      if (pending.current) {
        setNotice('uncertain');
        return { status: 'pending' };
      }
      return deliverProposal({
        kind: 'proposal',
        epoch: now.epoch,
        where:
          kind === 'demo' ? { kind, sessionId: sessionId ?? '', memberId } : { kind, memberId },
        proposalId,
        operationId: op,
      });
    },
    [kind, key, sessionId, memberId, deliverProposal],
  );

  /**
   * 決める画面の「選んだら」を読む（サーバーが書き込まずに同じ計算をした結果。何も書かない）。読めない・
   * 待つ間に使う人が替わった時は無し（画面は「選んだら」を出さずに、ふだんの案を見せる）。
   */
  const preview = useCallback(
    async (arrangementKey: string): Promise<ChoicePreview[] | undefined> => {
      const now = current.current;
      if (!kind || !memberId || now.key !== key || now.memberId !== memberId) return undefined;
      if (kind === 'demo' && !sessionId) return undefined;
      const query = `arrangement=${encodeURIComponent(arrangementKey)}`;
      const url =
        kind === 'demo'
          ? `/api/demo/sessions/${sessionId}/preview?member=${encodeURIComponent(memberId)}&${query}`
          : `/api/preview?as=${encodeURIComponent(memberId)}&${query}`;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
        if (!response.ok || !isCurrent(now.epoch)) return undefined;
        const body = (await response.json()) as { previews?: ChoicePreview[] };
        return isCurrent(now.epoch) ? body.previews : undefined;
      } catch {
        return undefined;
      }
    },
    [kind, key, sessionId, memberId, isCurrent],
  );

  /** 店までの徒歩の道（デモの地図）。読めなければ無し。 */
  const walk = useCallback(
    async (storeId: string): Promise<WalkView | undefined> => {
      if (kind !== 'demo' || !sessionId) return undefined;
      try {
        const response = await fetch(
          `/api/demo/sessions/${sessionId}/maps/walk?store=${encodeURIComponent(storeId)}`,
          { signal: AbortSignal.timeout(READ_TIMEOUT_MS) },
        );
        if (!response.ok) return undefined;
        return (await response.json()) as WalkView;
      } catch {
        return undefined;
      }
    },
    [kind, sessionId],
  );

  /** 品物から、店を探す言葉の案（Claude の推定。何も書かない）。読めなければ無し。 */
  const storeKinds = useCallback(
    async (what: string): Promise<string[] | undefined> => {
      if (kind !== 'demo' || !sessionId) return undefined;
      try {
        const response = await fetch(`/api/demo/sessions/${sessionId}/maps/store-kinds`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ what }),
          signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        });
        if (!response.ok) return undefined;
        return ((await response.json()) as { queries: string[] }).queries;
      } catch {
        return undefined;
      }
    },
    [kind, sessionId],
  );

  /** 家の周りを調べる（記録した調べ、または Claude がいま調べる。何も書かない）。デモだけ。 */
  const survey = useCallback(
    async (live: boolean, operationId: string): Promise<SurveyRunResult> => {
      if (kind !== 'demo' || !sessionId || !memberId) return { status: 'failed' };
      try {
        const response = await fetch(`/api/demo/sessions/${sessionId}/survey`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ memberId, operationId, live }),
          signal: AbortSignal.timeout(live ? SURVEY_TIMEOUT_MS : READ_TIMEOUT_MS),
        });
        const body = (await response.json()) as { survey: SurveyShown } | { error: string };
        if ('survey' in body) return { status: 'ok', survey: body.survey };
        if (body.error === 'unknownSession') {
          setNotice('expired');
          return { status: 'failed' };
        }
        if (body.error === 'readingLimit') return { status: 'limit' };
        if (body.error === 'readingBusy') return { status: 'busy' };
        if (body.error === 'noRecord') return { status: 'noRecord' };
        if (body.error === 'noArea') return { status: 'noArea' };
        return { status: 'failed' };
      } catch {
        return { status: 'failed' };
      }
    },
    [kind, sessionId, memberId],
  );

  /** 家庭の駅の近くで、家族が押した言葉の店を探す（言葉はそのまま Google に送る）。 */
  const searchStores = useCallback(
    async (query: string, stationId: string): Promise<StoreSearchResult> => {
      if (kind !== 'demo' || !sessionId) return { status: 'failed' };
      try {
        const response = await fetch(`/api/demo/sessions/${sessionId}/maps/stores`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query, stationId }),
          signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        });
        if (response.status === 429) return { status: 'limit' };
        if (!response.ok) return { status: 'failed' };
        return {
          status: 'ok',
          stores: ((await response.json()) as { stores: FoundStore[] }).stores,
        };
      } catch {
        return { status: 'failed' };
      }
    },
    [kind, sessionId],
  );

  /**
   * 変えた後に計画の何が変わるかを読む（サーバーが書き込まずに、書く時と同じ命令を展開した結果。何も書かない）。
   * 書けない変更は、その理由を返す。読めなければ無し。家の情報の直し（household-preview）と、「すること」の言明・
   * やり方の選び（change-preview）で同じ。
   */
  const previewAt = useCallback(
    async (
      path: 'household-preview' | 'change-preview',
      payload: { household: Household } | { command: PreviewCommand },
    ): Promise<HouseholdPreviewResult | undefined> => {
      const now = current.current;
      if (!kind || !memberId || now.key !== key || now.memberId !== memberId) return undefined;
      if (kind === 'demo' && !sessionId) return undefined;
      const url =
        kind === 'demo'
          ? `/api/demo/sessions/${sessionId}/${path}`
          : `/api/${path}?as=${encodeURIComponent(memberId)}`;
      const body = kind === 'demo' ? { memberId, ...payload } : payload;
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        });
        if (!isCurrent(now.epoch)) return undefined;
        const answer = (await response.json()) as { preview?: HouseholdPreview; error?: string };
        if (response.ok && answer.preview) return { preview: answer.preview };
        if (response.status === 409 && answer.error) return { refused: answer.error };
        return undefined;
      } catch {
        return undefined;
      }
    },
    [kind, key, sessionId, memberId, isCurrent],
  );
  const previewHousehold = useCallback(
    (household: Household) => previewAt('household-preview', { household }),
    [previewAt],
  );
  /**
   * 「すること」の言明・やり方の選び（と家の情報の直し）の「この変更で変わること」を読む（同じく何も書かない）。
   */
  const previewChange = useCallback(
    (command: PreviewCommand) => previewAt('change-preview', { command }),
    [previewAt],
  );

  // 今の代の見せる物だけを返す（替えた直後は、読み終えるまで何も見せない）。家族の大人でなく
  // なった（外された）と分かったら、前に読んだ物も見せない。
  const view = shown && shown.epoch === epoch && !denied && !switched ? shown.view : undefined;

  return {
    view,
    failed,
    /** 身元を確かめられない・家族の大人でない（家族の家庭だけ）。 */
    denied,
    /** ログインの身元が、画面の大人と替わった（家族の家庭だけ。身元を確かめ直す）。 */
    switched,
    notice,
    clearNotice: () => setNotice(undefined),
    send,
    read,
    transcribe,
    hear,
    confirm,
    wayIdeas,
    preview,
    previewHousehold,
    previewChange,
    walk,
    storeKinds,
    searchStores,
    survey,
    /** 届いたか分からない操作を、同じ家庭・同じ大人・同じ ID・同じ代で送り直す。 */
    retry: async (): Promise<void> => {
      const operation = pending.current;
      if (!operation || !isCurrent(operation.epoch)) return;
      if (operation.kind === 'command') {
        await deliver(operation);
        return;
      }
      // 一言の答えは閉じてあるので、記録の結果は、この知らせで伝える。
      const result = await deliverProposal(operation);
      if (result.status === 'ok') setNotice(undefined);
      else if (result.status === 'changed') setNotice('changed');
      else if (result.status === 'refused' || result.status === 'gone') setNotice('refused');
    },
    /** 見せる物を読み直す（何も書かない。相手の答えなど、ほかから届いた物を見る）。 */
    refresh: () => setReload((n) => n + 1),
    /** 届いたか分からない操作を、送り直さずに手放す（次の押下は別の操作になる）。 */
    discard: () => {
      pending.current = undefined;
      setNotice(undefined);
    },
  };
}

export type ServerView = ReturnType<typeof useServerView>;

/** デモの家庭：段を替えるか、やり直すと、新しいデモの家庭をサーバーに作る。 */
export function useDemoSession(stage: string, memberId: string | undefined) {
  const [session, setSession] = useState<Session>();
  const [sessionFailed, setSessionFailed] = useState(false);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    void generation;
    let cancelled = false;
    setSessionFailed(false);
    setSession(undefined);
    fetch('/api/demo/sessions', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ stage }),
    })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<Session>;
      })
      .then((made) => {
        if (!cancelled) setSession(made);
      })
      .catch(() => {
        if (!cancelled) setSessionFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [stage, generation]);

  const live = useServerView(
    session && memberId ? { kind: 'demo', sessionId: session.sessionId, memberId } : undefined,
  );
  return {
    ...live,
    session,
    failed: sessionFailed || live.failed,
    restart: () => setGeneration((g) => g + 1),
  };
}

/** 家族の家庭（ログインした大人。使う人は身元で決まり、替えない）。 */
export function useFamilySession(memberId: string) {
  return useServerView({ kind: 'family', memberId });
}

/** どちらの家庭を見せるか（サーバーに聞く）。家族の家庭の無いサーバーは、デモだけ。 */
export type Mode =
  | { kind: 'loading' }
  | { kind: 'demo' }
  /**
   * pushKey：知らせの登録に使う公開鍵（サーバーに知らせが無ければ無い）。canRead・canHear：お知らせ・一言を
   * Claude で読めるか（試しの家庭で、読み取りの鍵があるサーバーだけ）。
   */
  | { kind: 'family'; memberId: string; pushKey?: string; canRead?: true; canHear?: true }
  | { kind: 'denied' }
  | { kind: 'failed' };

/** どちらの家庭か。recheck で、ログインの身元を確かめ直す（替わった時）。 */
export function useMode(): { mode: Mode; recheck: () => void } {
  const [mode, setMode] = useState<Mode>({ kind: 'loading' });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    void version;
    let cancelled = false;
    setMode({ kind: 'loading' });
    fetch('/api/me')
      .then(async (response): Promise<Mode> => {
        if (response.status === 401 || response.status === 403) return { kind: 'denied' };
        if (!response.ok) throw new Error(String(response.status));
        const me = (await response.json()) as
          | { mode: 'demo' }
          | {
              mode: 'family';
              memberId: string;
              pushKey?: string;
              canRead?: boolean;
              canHear?: boolean;
            };
        if (me.mode !== 'family') return { kind: 'demo' };
        return {
          kind: 'family',
          memberId: me.memberId,
          ...(typeof me.pushKey === 'string' ? { pushKey: me.pushKey } : {}),
          ...(me.canRead === true ? { canRead: true as const } : {}),
          ...(me.canHear === true ? { canHear: true as const } : {}),
        };
      })
      .then((next) => {
        if (!cancelled) setMode(next);
      })
      .catch(() => {
        if (!cancelled) setMode({ kind: 'failed' });
      });
    return () => {
      cancelled = true;
    };
  }, [version]);
  // 知らせから、前から開いていた画面に戻った：ログインが替わった後かもしれないので確かめ直す。
  useEffect(() => {
    const container = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker;
    if (!container) return;
    const listen = (event: MessageEvent) => {
      if ((event.data as { type?: unknown } | null)?.type === 'maniau:opened') {
        setVersion((v) => v + 1);
      }
    };
    container.addEventListener('message', listen);
    return () => container.removeEventListener('message', listen);
  }, []);
  return { mode, recheck: () => setVersion((v) => v + 1) };
}
