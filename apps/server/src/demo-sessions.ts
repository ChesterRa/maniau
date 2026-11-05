// デモの家庭（ログインの無い、架空の家族）。見る人ごとに、段の事象から作った家庭をメモリに置く。
// 一人の操作が、別の人の見るデモを変えないようにする。古い物から捨てる。
import { createHash, randomUUID } from 'node:crypto';
import type { MapInputs } from '@maniau/core';
import {
  type CheckedIdeas,
  type ChoicePreview,
  type Command,
  checkSurvey,
  checkWayIdeas,
  type DateTime,
  type DomainEvent,
  type Extraction,
  formatDateTime,
  type Household,
  type MemberDayReply,
  type PlaceAttribution,
  type PlanResult,
  type PreviewCommand,
  type ProposalSeen,
  type RecordBlock,
  recordBlock,
  type Source,
  type SourceSender,
  type SurveyCandidate,
  type SurveyShown,
  seenOf,
  splitSentences,
  taskContent,
  toExtraction,
  toUtteranceReply,
  type UnsupportedReason,
  type UtteranceContext,
  type UtteranceRefs,
  type UtteranceReply,
  type WayIdeasContext,
  wayIdeasContext,
} from '@maniau/core';
import { computePlan, currentItems, foldEvents } from '@maniau/core/engine';
import {
  type AnswerResult,
  type AnswerSubmit,
  type AnswerView,
  answerView,
  type LinkEntry,
  submitAnswer,
} from './answer-link';
import {
  answerTokenHash,
  type CommandGuard,
  type CommandResult,
  reopened,
  runCommand,
} from './commands';
import { DEMO_STAGES, type DemoStageId, demoEvents, loadDemoData } from './demo';
import type { LatLng, MapsClient, WalkRoute } from './maps/google';
import { mapInputsFor, withProposed } from './maps/inputs';
import { type FoundStore, searchStores } from './maps/search';
import { notificationPreview } from './notify-preview';
import { previewChange, previewChoices } from './preview';
import {
  buildExtractInput,
  type ExtractRequest,
  type ExtractResult,
  ReadingError,
} from './reading/extract';
import type { StoreKindsResult } from './reading/store-kinds';
import {
  SURVEY_KINDS,
  type SurveyInput,
  type SurveyResult,
  surveyCandidateId,
  surveyInputFor,
} from './reading/survey';
import { type PhotoInput, PhotoTooLarge, type TranscribeResult } from './reading/transcribe';
import { buildUtteranceInput, type UtteranceResult } from './reading/utterance';
import type { WayIdeasResult } from './reading/way-ideas';
import { memoryStore } from './store';
import { utteranceContext } from './utterance-context';
import { type View, viewFor } from './views';

const MAX_SESSIONS = 200;
/** 一つの答えるリンクで、一分に受ける数（読む・書くの合計）。 */
export const MAX_LINK_REQUESTS_PER_MINUTE = 30;
/** 一つのデモで出せる答えるリンクの数（鍵の表を際限なく大きくしない）。 */
export const MAX_LINKS_PER_SESSION = 50;
const TTL_MS = 12 * 60 * 60 * 1000;
/** 使われないデモも、この間ごとに捨てる（入れた文を、使わなくなってから長く置かない）。 */
const SWEEP_MS = 10 * 60 * 1000;
/** 一つのデモで読めるお知らせの数（Claude の費用と、使い方の乱れを抑える）。 */
export const MAX_READINGS_PER_SESSION = 5;
/** サーバー全体で、一日に読めるお知らせの数。 */
export const MAX_READINGS_PER_DAY = 100;
/** サーバー全体で、同時に読むお知らせの数（一つのデモでは一つずつ）。 */
export const MAX_READINGS_IN_FLIGHT = 2;
/**
 * 一回の読み取りでモデルに送る入力（決まった指示を除く）の長さ。入れた文に、前に読んだ事項も一緒に
 * 送るので、文の長さだけでは一回の量が決まらない。超える時は呼ばない。
 */
export const MAX_READING_INPUT_CHARS = 40_000;

/** 送る入力が上限に収まるか（送る物と同じ形で数える）。 */
export const readingInputFits = (request: ExtractRequest) =>
  buildExtractInput(request).length <= MAX_READING_INPUT_CHARS;

/** お知らせを Claude で読む（試験では偽物に替える）。 */
export type NoticeReader = (request: ExtractRequest) => Promise<ExtractResult>;

/** 一つのデモで書き起こせる写真・PDF の数（一日の数と、同時に読む数は、お知らせと同じ枠を使う）。 */
export const MAX_PHOTOS_PER_SESSION = 5;

/** お知らせの写真・PDF を Claude で書き起こす（試験では偽物に替える）。 */
export type PhotoReader = (photo: PhotoInput) => Promise<TranscribeResult>;

export type PhotoResult =
  | { status: 'ok'; text: string }
  /** tooLarge：入力の見積もりが多すぎて、書き起こしを呼ばなかった（見積もりで Anthropic に送ったので、一回と数える）。 */
  | { status: 'limit' | 'busy' | 'invalid' | 'conflict' | 'tooLarge' }
  | { status: 'failed'; reason: string };

/** 一つのデモで読める一言の数（一言は短く、何度も言い直すので、お知らせより多くする）。 */
export const MAX_UTTERANCES_PER_SESSION = 20;
/** 一言を読む時に送る入力（前提の計画を含む）の長さ。 */
export const MAX_UTTERANCE_INPUT_CHARS = 40_000;

/** 家族の一言を Claude で読む（試験では偽物に替える）。 */
export type UtteranceReader = (context: UtteranceContext) => Promise<UtteranceResult>;

export interface UtteranceInput {
  text: string;
  /** 画面が付ける操作の ID。送り直しで、二度読まない。 */
  operationId: string;
}

/** 画面に返す一言の答え。候補の控え（見せた時の状態）はサーバーに置き、命令と ID だけを返す。 */
/** 見せる候補。値の答えの候補には、その問いの名前（お知らせの読み取りの物）を添える。 */
export interface ShownProposal {
  id: string;
  command: Command;
  label?: string;
  /**
   * 一言からは記録させない訳（core の recordBlock。同じ種類の対象がほかにもある等）。画面は記録の手を出さず、
   * 札へ案内する。押されても、家庭を押さえた中で同じ判断をし直して断る。
   */
  blocked?: RecordBlock;
}

export type ShownReply =
  | { kind: 'change'; proposals: ShownProposal[] }
  | {
      kind: 'clarify';
      proposals: ShownProposal[];
      reason: 'ambiguous' | 'otherAdultsTask' | 'unowned';
      unowned?: true;
    }
  /** 仮の話：断られたと仮に置く頼み事の候補（返事待ちの物だけ。空なら無い）。何も記録しない。 */
  | { kind: 'whatIf'; requestIds: string[] }
  /** 大人のある一日の話（休む・外出・遅くなる）。何も記録しない（家族が前提の画面で見て、別に押す）。 */
  | { kind: 'memberDay'; day: MemberDayReply }
  | { kind: 'question'; refs: UtteranceRefs }
  | { kind: 'unsupported'; reason: UnsupportedReason };

export type UtteranceOutcome =
  | { status: 'ok'; view: View; reply: ShownReply }
  | { status: 'limit' }
  | { status: 'busy' }
  | { status: 'invalid' }
  | { status: 'conflict' }
  /** 読む間に計画が変わった（古い前提の答えを、今の事実として見せない）。もう一度読んでもらう。 */
  | { status: 'stale' }
  | { status: 'failed'; reason: string };

/** 一つのデモで出せる、やり方の案の数（一日の数と、同時に読む数は、お知らせと同じ枠を使う）。 */
export const MAX_WAY_IDEAS_PER_SESSION = 5;
/** 一つのデモで、店の検索語を Claude に聞ける数と、地図で店を探せる数。 */
export const MAX_STORE_KINDS_PER_SESSION = 10;
export const MAX_STORE_SEARCHES_PER_SESSION = 20;

/** 品物から、地図で店を探す検索語の候補を Claude が出す（試験では偽物に替える）。 */
export type StoreKindsReader = (what: string) => Promise<StoreKindsResult>;
/** 店の検索語の候補を聞く品物の名前と、地図で探す検索語の長さの上限（字）。 */
export const MAX_STORE_TEXT_CHARS = 40;

/** 新しい「すること」に、Claude がやり方の案を出す（試験では偽物に替える）。 */
export type WayIdeasReader = (context: WayIdeasContext) => Promise<WayIdeasResult>;

export interface WayIdeasInput {
  arrangementKey: string;
  /** 家族の考え（任意）。 */
  text?: string;
  /** 案を書く言葉（画面の言葉）。 */
  language: 'ja' | 'en';
  /** 画面が付ける操作の ID。送り直しで、二度作らない。 */
  operationId: string;
}

export type WayIdeasOutcome =
  /** sent：モデルに送った物（画面が、送った物として見せる）。何も書かない。 */
  | { status: 'ok'; ideas: CheckedIdeas; sent: WayIdeasContext }
  | { status: 'limit' | 'busy' | 'invalid' | 'conflict' }
  /** 作る間に、「すること」か家の情報が変わった（古い前提の案を見せない）。 */
  | { status: 'stale' }
  /** 手配が今の計画に無いか、生きていない。 */
  | { status: 'needGone' }
  | { status: 'failed'; reason: string };

interface WayIdeasOperation {
  digest: string;
  state: 'reading' | 'done';
  ideas?: CheckedIdeas;
  sent?: WayIdeasContext;
}

/**
 * 一つのデモで、Claude にいま周りを調べてもらえる数（記録した調べは数えない）。作り手の決めた範囲（2026-11-05：
 * 足りるだけ開けるが、使いすぎない）。
 */
export const MAX_SURVEYS_PER_SESSION = 3;
/** サーバー全体で、一日に Claude にいま周りを調べてもらえる数（検索と頁の読み取りで、一回が重い）。 */
export const MAX_SURVEYS_PER_DAY = 30;

/** 家の周りを Claude で調べる（試験では偽物に替える）。 */
export type SurveyReader = (input: SurveyInput) => Promise<SurveyResult>;

export type SurveyOutcome =
  | { status: 'ok'; survey: SurveyShown }
  | { status: 'limit' | 'busy' | 'invalid' | 'conflict' }
  /** 家の場所に地域が無い（どこを調べるか分からない）。 */
  | { status: 'noArea' }
  /** 記録した調べが無いか、この家の地域の物ではない（いま調べてもらう）。 */
  | { status: 'noRecord' }
  | { status: 'failed'; reason: string };

interface SurveyOperation {
  digest: string;
  state: 'reading' | 'done';
  survey?: SurveyShown;
}

export type ConfirmOutcome =
  | { status: 'ok'; view: View }
  /** 見せた後に、対象の状態が変わった（もう一人が記録した等）。記録せず、今の物を見せ直す。 */
  | { status: 'changed'; view: View }
  /** 命令が断られた（権限・前提）。 */
  | { status: 'refused'; result: CommandResult; view: View }
  /** 知らない候補（期限切れのデモの物を含む）。 */
  | { status: 'gone' }
  /** 一言を言った本人ではない。 */
  | { status: 'forbidden' };

/** 読み取りで、家族に確かめてほしい所（原文の文。どの文か分からない時は全体）。 */
export interface ReadCheck {
  sentenceIds: string[];
  all: boolean;
}

export interface NoticeInput {
  text: string;
  sender: SourceSender;
  /** 写真・PDF から書き起こし、家族が見比べて直した文なら photo。 */
  medium?: Source['medium'];
  /** 画面が付ける操作の ID。届いたか分からない時の送り直しで、二度読まない・二度足さない。 */
  operationId: string;
}

export type NoticeResult =
  | { status: 'ok'; view: View; sourceId: string; check: ReadCheck }
  /** このデモで読める数・量、または今日このサーバー（のこのプロセス）で読める数を使い切った。 */
  | { status: 'limit' }
  /** このデモで読んでいる途中か、サーバー全体で読む数がいっぱい。少し待てば読める。 */
  | { status: 'busy' }
  /** 使う人がこの家族の大人でない。 */
  | { status: 'invalid' }
  /** 同じ操作 ID で、違う文・違う人が送った。 */
  | { status: 'conflict' }
  /** 読む間に、前提の事項（家族の直し・確かめ・別のお知らせ）や時計が変わった。足さない。 */
  | { status: 'stale' }
  /** 読めなかった（拒否・打ち切り・通信・形の合わない出力）。何も足さない。 */
  | { status: 'failed'; reason: string };

/** 読み取りの操作の控え。読んでいる物と、読んで足した物だけを置く（失敗した物は、同じ ID で読み直せる）。 */
interface ReadingOperation {
  /** 送った中身の要約（同じ ID で中身の違う送り直しを見分ける）。 */
  digest: string;
  state: 'reading' | 'done';
  sourceId?: string;
  check?: ReadCheck;
}

interface UtteranceOperation {
  digest: string;
  state: 'reading' | 'done';
  reply?: ShownReply;
  /** 読んだ時の前提の要約。送り直しの時に今と比べ、変わっていれば古い答えを返さない。 */
  context?: string;
}

interface StoredProposal {
  memberId: string;
  command: Command;
  seen: ProposalSeen;
  /** 見せた時に、一言からは記録させないとした訳。 */
  blocked?: RecordBlock;
}

interface Session {
  now: DateTime;
  touched: number;
  /** このデモで出した答えるリンクの鍵の sha256（デモを捨てる時に、鍵の表から外す）。 */
  links?: Set<string>;
  /** このデモで読んだ（読もうとした）お知らせの数。 */
  readings: number;
  /** いま読んでいる操作の ID（お知らせと一言で一つずつ）。 */
  reading?: string;
  operations: Map<string, ReadingOperation>;
  /** このデモで書き起こした（書き起こそうとした）写真・PDF の数。 */
  photos: number;
  /** 書き起こしの操作（送り直しには、もう一度呼ばずに同じ文を返す。写真は残さない）。 */
  /** 操作ごとの控え。結果の無い間は、書き起こしの途中。 */
  photoOperations: Map<
    string,
    { digest: string; result?: { status: 'ok'; text: string } | { status: 'tooLarge' } }
  >;
  /** このデモで読んだ（読もうとした）一言の数。 */
  utterances: number;
  utteranceOperations: Map<string, UtteranceOperation>;
  /** このデモで出した（出そうとした）やり方の案の数と、操作ごとの控え。 */
  wayIdeas: number;
  wayIdeasOperations: Map<string, WayIdeasOperation>;
  /** 見せた候補（確かめるまで、何も書かない）。 */
  proposals: Map<string, StoredProposal>;
  /** このデモで、Claude に店の検索語を聞いた数と、地図で店を探した数。 */
  storeKinds: number;
  storeSearches: number;
  /** このデモで Claude にいま周りを調べてもらった（もらおうとした）数と、操作ごとの控え。 */
  surveys: number;
  surveyOperations: Map<string, SurveyOperation>;
  /**
   * このデモで見せた周りの資源の候補（ID ごとに最後に見せた物）。家族が家に入れる時、送られた資源と前提を、ここに
   * ある物と比べる（見せていない物・中身を替えた物は入れない）。
   */
  surveyed: Map<string, SurveyCandidate>;
}

/** 店までの徒歩の道（画面の地図）。Google の名前・位置・道は、この応答で見せるだけ。 */
export interface WalkView {
  /** Google に照会した実際の時刻。 */
  checkedAt: DateTime;
  /** attributions：名前と一緒に見せなければならない、データの提供者（駅と店で別々）。 */
  station: { id: string; name?: string; location: LatLng; attributions?: PlaceAttribution[] };
  store: {
    id: string;
    name?: string;
    location: LatLng;
    googleMapsUri?: string;
    attributions?: PlaceAttribution[];
  };
  route: WalkRoute;
}

/**
 * 読み取りに渡す前提：家族の直しと確かめを重ねた、今の事項（取り下げ・置き換え・取り消しを受けた物を
 * 除く）と、取り下げていないお知らせの未定の値と、届いた時刻。読む間に変わったかを見るため、決まった
 * 未定の値（家族の答え・お知らせの作用）も持つ（モデルには渡さない）。家族の大人でなければ無し。
 */
function contextOf(events: readonly DomainEvent[], memberId: string, fallback: DateTime) {
  const state = foldEvents(events);
  const adult = state.household?.members.some(
    (m) => m.id === memberId && m.kind === 'adult' && m.active,
  );
  if (!state.household || !adult) return undefined;
  return {
    at:
      state.clock === undefined ? fallback : formatDateTime(state.clock, state.household.timeZone),
    items: currentItems(state).map((c) => c.item),
    unknowns: [...state.extractions.values()]
      .filter((e) => !state.withdrawnSources.has(e.sourceId))
      .flatMap((e) => e.unknowns),
    // 同じ値の答え直しも、後からの家族の事実なので、値だけでなく順番と出どころも比べる。
    answers: [...state.resolved]
      .map(([id, r]) => [id, r.value, r.seq, r.by] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  };
}

/** 学年度（4月始まり）。読み取りで、書かれた月日の年を決めるのに使う。 */
function schoolYearOf(at: DateTime): string {
  const year = Number(at.slice(0, 4));
  return String(Number(at.slice(5, 7)) >= 4 ? year : year - 1);
}

/** 原文の言葉：かなか漢字があれば日本語として読む（訳さずに原文を残す）。 */
const languageOf = (text: string): Source['language'] =>
  /[\u3040-\u30ff\u4e00-\u9fff]/.test(text) ? 'ja' : 'en';

/** 一行目を題にする（長ければ切る）。 */
function titleOf(text: string): string | undefined {
  const first = text.trim().split(/\r?\n/)[0]?.trim();
  if (!first) return undefined;
  return first.length > 40 ? `${first.slice(0, 40)}…` : first;
}

/** 一言の前提の要約（送り直しの時に、読んだ時の前提と今を比べる）。 */
const contextDigest = (context: UtteranceContext) =>
  createHash('sha256').update(JSON.stringify(context)).digest('hex');

/**
 * デモの見せる物：家族の家庭と同じ物に、この時刻の知らせの候補を添える（送らない・記録しない。
 * notify-preview.ts）。デモには送り手が無いので、知らせの決まりを画面で確かめられるようにする。
 */
function demoView(
  events: readonly DomainEvent[],
  memberId: string,
  now: DateTime,
  maps: MapInputs | undefined,
): View {
  const view = viewFor(events, memberId, now, maps);
  return { ...view, notificationPreview: notificationPreview(events, view.plan, view.household) };
}

export function demoSessions(
  clock: () => number = Date.now,
  /** 試験で数の上限を小さくする。 */
  limits: { perDay?: number; surveysPerDay?: number } = {},
  /**
   * 地図の口（無ければ地図を使わず、家庭の目安で計算する。試験は架空の口を渡す）。recordedSurvey は、記録した
   * 周りの調べ（無ければデモの材料の物。null なら無し）。
   */
  deps: { maps?: MapsClient; mapsClock?: () => number; recordedSurvey?: SurveyShown | null } = {},
) {
  const perDay = limits.perDay ?? MAX_READINGS_PER_DAY;
  const surveysPerDay = limits.surveysPerDay ?? MAX_SURVEYS_PER_DAY;
  const recordedSurvey =
    deps.recordedSurvey === undefined ? loadDemoData().survey : (deps.recordedSurvey ?? undefined);
  /** 今日（サーバーの時計の日付）Claude にいま周りを調べてもらった数。 */
  const dailySurveys = { day: '', count: 0 };
  const store = memoryStore();
  const sessions = new Map<string, Session>();
  /** 今日（サーバーの時計の日付）読んだ数。 */
  const daily = { day: '', count: 0 };
  /** いま読んでいる数（サーバー全体）。 */
  let inFlight = 0;

  /** 答えるリンクの鍵の sha256 → どのデモの、どの「すること」の、だれのリンクか（デモと同じ寿命）。 */
  const linkIndex = new Map<string, LinkEntry>();
  /** 答えるリンクごとの、今の一分に受けた数。 */
  const linkRequests = new Map<string, { start: number; count: number }>();
  const drop = (id: string) => {
    const session = sessions.get(id);
    sessions.delete(id);
    store.drop(id);
    for (const hash of session?.links ?? []) {
      linkIndex.delete(hash);
      linkRequests.delete(hash);
    }
  };

  const sweep = () => {
    const now = clock();
    for (const [id, session] of sessions) {
      if (now - session.touched > TTL_MS) drop(id);
    }
    for (const [hash, window] of linkRequests) {
      if (now - window.start >= 60_000) linkRequests.delete(hash);
    }
    while (sessions.size >= MAX_SESSIONS) {
      // 読んでいる途中のデモは追い出さない（外に送った後の結果を捨てず、後の段の呼び出しも無駄にしない）。
      // 途中の物は同時に読む数までなので、上限を少し超えるだけ。
      const oldest = [...sessions.entries()]
        .filter(([, s]) => s.reading === undefined)
        .sort((a, b) => a[1].touched - b[1].touched)[0];
      if (!oldest) break;
      drop(oldest[0]);
    }
  };

  // 誰も触らなくても掃除する。プロセスの終わりは止めない。
  setInterval(sweep, SWEEP_MS).unref();

  // 期限を過ぎたデモは、作る時の掃除を待たずに、触った時にも捨てる。
  const touch = (id: string) => {
    const session = sessions.get(id);
    if (!session) return undefined;
    if (clock() - session.touched > TTL_MS) {
      drop(id);
      return undefined;
    }
    session.touched = clock();
    return session;
  };
  /**
   * 答えるリンクの鍵から、生きているデモと表の一行を引く（数の上限を超えたら tooMany）。鍵が今も効くかは、押さえた
   * 中で確かめ直す（answer-link）。
   */
  const linkOf = (
    token: string,
  ): { hash: string; entry: LinkEntry; session: Session } | 'tooMany' | undefined => {
    const hash = answerTokenHash(token);
    const entry = linkIndex.get(hash);
    if (!entry) return undefined;
    const session = sessions.get(entry.householdId);
    if (!session || clock() - session.touched > TTL_MS) return undefined;
    const now = clock();
    const window = linkRequests.get(hash);
    if (!window || now - window.start >= 60_000) linkRequests.set(hash, { start: now, count: 1 });
    else if (window.count >= MAX_LINK_REQUESTS_PER_MINUTE) return 'tooMany';
    else window.count += 1;
    return { hash, entry, session };
  };
  // 待つ間に、期限が切れた・数の上限で捨てたデモではないか（外に送る前と、結果を足す前に確かめる）。
  const alive = (id: string, session: Session) =>
    sessions.get(id) === session && clock() - session.touched <= TTL_MS;

  /**
   * この要求のための地図の根拠。家庭を押さえる前に引く（待つ間、ほかの画面を止めない）。同じ要求の計算・
   * 確かめ・画面は、これ一つを使う。要求をまたいで使い回さない（Google の条件）。地図の口が無い・失敗・
   * 上限の時は無し（家庭の目安で計算する）。押さえた中のエンジンは、店・駅の ID が合う時だけ使う。
   */
  const mapsOf = async (id: string, proposed?: Household): Promise<MapInputs | undefined> => {
    const client = deps.maps;
    if (!client) return undefined;
    const household = await store.withHousehold(id, (log) => foldEvents(log.events()).household);
    if (!household) return undefined;
    return mapInputsFor(withProposed(household, proposed), client, deps.mapsClock).catch(
      () => undefined,
    );
  };
  /** 家の情報の直し（見る・保存）は、直した後の家庭の店の根拠も一緒に引く（新しく選んだ店も、見た時に置ける）。 */
  const proposedOf = (command: Command | PreviewCommand) =>
    command.type === 'updateHousehold' ? command.household : undefined;

  /** 読む前の前提を取り、Claude で読み、前提が変わっていない時だけ、出典と読み取りを一度に足す。 */
  async function readNotice(
    id: string,
    session: Session,
    memberId: string,
    input: NoticeInput,
    digest: string,
    read: NoticeReader,
  ): Promise<NoticeResult | undefined> {
    const prior = await store.withHousehold(id, (log) =>
      contextOf(log.events(), memberId, session.now),
    );
    // 前提を取る間にデモが消えたら、外に送らない（結果を返せないのに、送らないように）。
    if (!alive(id, session)) return undefined;
    if (!prior) return { status: 'invalid' };
    const sourceId = `u${session.readings}`;
    const title = titleOf(input.text);
    const source: Source = {
      id: sourceId,
      version: 1,
      receivedAt: prior.at,
      sender: input.sender,
      language: languageOf(input.text),
      medium: input.medium ?? 'text',
      ...(title ? { title } : {}),
      sentences: splitSentences(input.text, sourceId),
    };
    const request: ExtractRequest = {
      source,
      schoolYear: schoolYearOf(prior.at),
      priorItems: prior.items,
      priorUnknowns: prior.unknowns,
    };
    if (!readingInputFits(request)) return { status: 'limit' };
    let result: ExtractResult;
    let extraction: Extraction;
    try {
      result = await read(request);
      ({ extraction } = toExtraction(result.output, source, {
        priorItems: prior.items,
        priorUnknowns: prior.unknowns,
      }));
    } catch (error) {
      // 形の合わない出力（検査に通らない物）も、読めなかったとして何も足さない。
      return { status: 'failed', reason: error instanceof ReadingError ? error.reason : 'error' };
    }
    const check: ReadCheck = {
      sentenceIds: extraction.checkSentenceIds ?? [],
      all: extraction.checkAll ?? false,
    };
    // 読む間に期限が切れた・数の上限で捨てたデモには足さない（押さえた中でも、もう一度確かめる）。
    const gone = () => !alive(id, session);
    if (gone()) return undefined;
    const maps = await mapsOf(id);
    // 足す途中で投げたら（形の合わない記録など）、置き場所が全部を戻す。読めなかったとして返す。
    return store
      .withHousehold(id, (log): NoticeResult | undefined => {
        if (gone()) return undefined;
        // 読む間に前提が変わったら（家族が事項を直した等）、古い前提の読み取りを足さない（直した事を
        // 古い読み取りの作用で消さない）。読み直してもらう。
        // 読む間に大人でなくなった時も、前提が変わったとする（呼んだ分は数えたまま）。
        const now = contextOf(log.events(), memberId, session.now);
        if (!now || JSON.stringify(now) !== JSON.stringify(prior)) return { status: 'stale' };
        const before = computePlan(log.events(), session.now, maps);
        log.append([{ type: 'noticeReceived', source }], memberId, prior.at);
        log.append(
          [
            {
              type: 'modelOutputRecorded',
              call: 'extract',
              model: result.model,
              promptVersion: result.promptVersion,
              inputHash: result.inputHash,
              sourceId,
              sourceVersion: 1,
              output: extraction,
            },
          ],
          'system',
          prior.at,
        );
        // 新しいお知らせで、「もう要りません」と出ていた引き受けが戻ったら、本人にもう一度頼む。
        const back = reopened(before, computePlan(log.events(), session.now, maps));
        if (back.length > 0) log.append(back, 'system', prior.at);
        const view = demoView(log.events(), memberId, session.now, maps);
        // 足し終えてから、操作を済みにする（途中で投げて戻した時に、済みと答えない）。
        session.operations.set(input.operationId, { digest, state: 'done', sourceId, check });
        return { status: 'ok', view, sourceId, check };
      })
      .catch((): NoticeResult => ({ status: 'failed', reason: 'error' }));
  }

  /**
   * 候補の命令に、前提で見せた物を付ける：済んだには作業の今の用件（「すること」の中身とやり方の版も。画面の
   * 「済んだ」と同じ）、家にあるかの答えには品物、送ったには頼む時間（子の居場所の手配と、窓の「すること」の
   * 手配の区間）（命令は見せた物を必ず持つ。押すまでに直されて別の物になっていれば、サーバーが断る）。
   */
  // 家にあるかの答えには、モデルに渡した前提が見ていた事象の位置を付ける（その後に入った答えを、古い
  // 候補で上書きしない。札と同じ確かめ）。
  const withSeen = (command: Command, plan: PlanResult, throughSeq: number): Command => {
    if (command.type === 'recordSent') {
      const task = plan.tasks.find((t) => t.key === command.taskKey);
      const arrangement = plan.arrangements.find((a) => a.key === task?.basis.arrangementKey);
      // 頼む時間は、子の居場所の手配と、窓の「すること」の手配の区間（画面の「送った」と同じ）。
      return arrangement?.kind === 'childCare' ||
        (arrangement?.kind === 'need' && arrangement.needShape === 'window')
        ? { ...command, window: { start: arrangement.start, end: arrangement.end } }
        : command;
    }
    if (command.type === 'commitment' && command.action === 'done') {
      const task = plan.tasks.find((t) => t.key === command.taskKey);
      return task ? { ...command, seen: taskContent(task) } : command;
    }
    if (command.type === 'answer') {
      // 家にあるかには品物を、家族が決める値には見せた位置を付ける（サーバーが、今と同じ時だけ受ける。ほかの
      // 値では使わない）。
      const what = plan.requirements.find((r) => r.atHomeUnknownId === command.unknownId)?.what;
      return { ...command, seen: what === undefined ? { throughSeq } : { what, throughSeq } };
    }
    return command;
  };

  /** 候補を控えに置き、画面に返す形にする（控えの状態は返さない）。 */
  const show = (
    session: Session,
    reply: UtteranceReply,
    memberId: string,
    context: UtteranceContext,
    plan: PlanResult,
    throughSeq: number,
  ): ShownReply => {
    if (
      reply.kind === 'question' ||
      reply.kind === 'unsupported' ||
      reply.kind === 'whatIf' ||
      reply.kind === 'memberDay'
    ) {
      return reply;
    }
    const proposals = reply.proposals.map((p): ShownProposal => {
      const id = randomUUID();
      const command = withSeen(p.command, plan, throughSeq);
      // デモの家庭は試しの家庭ではない（「すること」の頼み事も、ほかに頼み事が無ければ一言で記録できる）。
      const blocked = recordBlock(p.command, context, plan, { trial: false });
      session.proposals.set(id, {
        memberId,
        command,
        seen: p.seen,
        ...(blocked ? { blocked } : {}),
      });
      const label =
        command.type === 'answer'
          ? context.unknowns.find((u) => u.id === command.unknownId)?.label
          : undefined;
      return { id, command, ...(label ? { label } : {}), ...(blocked ? { blocked } : {}) };
    });
    return reply.kind === 'change'
      ? { kind: 'change', proposals }
      : {
          kind: 'clarify',
          proposals,
          reason: reply.reason,
          ...(reply.unowned ? { unowned: true as const } : {}),
        };
  };

  /** 今の計画を前提に一言を読み、確かめた候補を返す。何も書かない。 */
  /** 今の事象から、やり方の案の前提を作る（家族の大人でなければ invalid、手配が無ければ needGone）。 */
  function ideasContextOf(
    events: readonly DomainEvent[],
    memberId: string,
    now: DateTime,
    input: WayIdeasInput,
  ): WayIdeasContext | 'invalid' | 'needGone' {
    const view = viewFor(events, memberId, now);
    if (!view.household.members.some((m) => m.id === memberId && m.kind === 'adult' && m.active)) {
      return 'invalid';
    }
    const context = wayIdeasContext(
      {
        plan: view.plan,
        items: view.items.map((l) => l.item),
        household: view.household,
        sources: view.sources,
      },
      input.arrangementKey,
      input.text,
      input.language,
      memberId,
    );
    return context ?? 'needGone';
  }

  /** 周りを調べる時にモデルに渡す物（家族の大人でなければ invalid）。 */
  function surveyInputOf(
    events: readonly DomainEvent[],
    memberId: string,
  ): SurveyInput | 'invalid' | 'noArea' {
    const household = foldEvents(events).household;
    if (!household?.members.some((m) => m.id === memberId && m.kind === 'adult' && m.active)) {
      return 'invalid';
    }
    return surveyInputFor(household, clock());
  }

  /** 前提を取り、Claude で案を作り、前提が変わっていない時だけ、確かめた案を返す（何も書かない）。 */
  async function ideas(
    id: string,
    session: Session,
    memberId: string,
    input: WayIdeasInput,
    digest: string,
    read: WayIdeasReader,
  ): Promise<WayIdeasOutcome | undefined> {
    const before = await store.withHousehold(id, (log) =>
      ideasContextOf(log.events(), memberId, session.now, input),
    );
    if (!alive(id, session)) return undefined;
    if (before === 'invalid') return { status: 'invalid' };
    if (before === 'needGone') return { status: 'needGone' };
    let result: WayIdeasResult;
    try {
      result = await read(before);
    } catch (error) {
      return { status: 'failed', reason: error instanceof ReadingError ? error.reason : 'error' };
    }
    if (!alive(id, session)) return undefined;
    return store
      .withHousehold(id, (log): WayIdeasOutcome | undefined => {
        if (!alive(id, session)) return undefined;
        // 作る間に「すること」・家の人・やり方が変わったら、古い前提の案を見せない。
        const after = ideasContextOf(log.events(), memberId, session.now, input);
        if (after === 'invalid') return { status: 'invalid' };
        if (after === 'needGone') return { status: 'needGone' };
        if (JSON.stringify(after) !== JSON.stringify(before)) return { status: 'stale' };
        const household = foldEvents(log.events()).household;
        if (!household) return { status: 'invalid' };
        const checked = checkWayIdeas(result.output, before, household);
        session.wayIdeasOperations.set(input.operationId, {
          digest,
          state: 'done',
          ideas: checked,
          sent: before,
        });
        return { status: 'ok', ideas: checked, sent: before };
      })
      .catch((): WayIdeasOutcome => ({ status: 'failed', reason: 'error' }));
  }

  async function hear(
    id: string,
    session: Session,
    memberId: string,
    input: UtteranceInput,
    digest: string,
    read: UtteranceReader,
  ): Promise<UtteranceOutcome | undefined> {
    // 一言の対象は、同じ要求で見せる計画（同じ地図の根拠）から選ぶ。
    const maps = await mapsOf(id);
    const heardOn = await store.withHousehold(id, (log) => {
      const events = log.events();
      const context = utteranceContext(events, memberId, session.now, input.text, maps);
      return context && { context, throughSeq: events.at(-1)?.seq ?? 0 };
    });
    if (!alive(id, session)) return undefined;
    if (!heardOn) return { status: 'invalid' };
    const { context, throughSeq } = heardOn;
    if (buildUtteranceInput(context).length > MAX_UTTERANCE_INPUT_CHARS) return { status: 'limit' };
    let reply: UtteranceReply;
    try {
      const result = await read(context);
      reply = toUtteranceReply(result.output, context, randomUUID);
    } catch (error) {
      return { status: 'failed', reason: error instanceof ReadingError ? error.reason : 'error' };
    }
    const gone = () => !alive(id, session);
    if (gone()) return undefined;
    return store
      .withHousehold(id, (log): UtteranceOutcome | undefined => {
        if (gone()) return undefined;
        // 読む間に前提（作業・頼み事・値・事項・時刻）が変わったら、古い前提で選んだ候補や答えを
        // 見せない（条件の決まった事項を、決まる前の答えで「予定」と見せない等）。読む間に入った答えは、
        // 同じ答えの言い直しでも前提が変わったものとする（もう一人の新しい答えに、古い前提の候補を並べない）。
        const events = log.events();
        if (events.some((e) => e.type === 'answered' && e.seq > throughSeq))
          return { status: 'stale' };
        const now = utteranceContext(events, memberId, session.now, input.text, maps);
        if (!now || JSON.stringify(now) !== JSON.stringify(context)) return { status: 'stale' };
        const view = demoView(log.events(), memberId, session.now, maps);
        const shown = show(session, reply, memberId, context, view.plan, throughSeq);
        session.utteranceOperations.set(input.operationId, {
          digest,
          state: 'done',
          reply: shown,
          context: contextDigest(context),
        });
        return { status: 'ok', view, reply: shown };
      })
      .catch((): UtteranceOutcome => ({ status: 'failed', reason: 'error' }));
  }

  return {
    /** 地図を使えるか（地図の口があるサーバーだけ）。 */
    mapsEnabled: deps.maps !== undefined,
    /**
     * 店の駅からその店までの徒歩の道（画面の地図に描く）。家庭の店と駅の place ID で引き、返すだけで
     * 取っておかない（Google の条件）。デモが無ければ null、地図の口が無い・店が地図に結び付かない・
     * 引けなかった時は undefined。
     */
    async walk(id: string, storeId: string): Promise<WalkView | null | undefined> {
      const session = touch(id);
      if (!session) return null;
      const client = deps.maps;
      if (!client) return undefined;
      const household = await store.withHousehold(id, (log) => foldEvents(log.events()).household);
      const shop = household?.places.find((p) => p.id === storeId && p.kind === 'store');
      const station = household?.places.find((p) => p.id === shop?.nearStationId);
      if (!household || !shop?.googlePlaceId || !station?.googlePlaceId) return undefined;
      try {
        const [from, to, route] = await Promise.all([
          client.place(station.googlePlaceId, { summary: true }),
          client.place(shop.googlePlaceId, { summary: true }),
          client.walkRoute(station.googlePlaceId, shop.googlePlaceId),
        ]);
        if (!route || !from.location || !to.location) return undefined;
        return {
          checkedAt: formatDateTime(
            Math.floor((deps.mapsClock ?? Date.now)() / 60_000),
            household.timeZone,
          ),
          station: {
            id: station.id,
            ...(from.name ? { name: from.name } : {}),
            ...(from.attributions ? { attributions: from.attributions } : {}),
            location: from.location,
          },
          store: {
            id: shop.id,
            ...(to.name ? { name: to.name } : {}),
            ...(to.attributions ? { attributions: to.attributions } : {}),
            location: to.location,
            ...(to.googleMapsUri ? { googleMapsUri: to.googleMapsUri } : {}),
          },
          route,
        };
      } catch {
        return undefined;
      }
    },
    /**
     * 品物から、地図で店を探す検索語の候補を Claude に聞く（推定。何も書かない）。送るのは品物の名前だけ。
     * 数は、お知らせ・一言と同じ一日の枠と、デモごとの上限で抑える。
     */
    async storeKinds(
      id: string,
      what: string,
      read: StoreKindsReader,
    ): Promise<
      { status: 'ok'; queries: string[] } | { status: 'limit' | 'busy' | 'failed' } | undefined
    > {
      const session = touch(id);
      if (!session) return undefined;
      const today = new Date(clock()).toISOString().slice(0, 10);
      if (daily.day !== today) Object.assign(daily, { day: today, count: 0 });
      if (session.storeKinds >= MAX_STORE_KINDS_PER_SESSION || daily.count >= perDay) {
        return { status: 'limit' };
      }
      if (inFlight >= MAX_READINGS_IN_FLIGHT) return { status: 'busy' };
      session.storeKinds += 1;
      daily.count += 1;
      inFlight += 1;
      try {
        return { status: 'ok', queries: (await read(what)).queries };
      } catch {
        return { status: 'failed' };
      } finally {
        inFlight -= 1;
      }
    },
    /**
     * 家庭の駅の近くで、検索語に合う本物の店を探す（家族が押した時だけ。結果は返すだけで取っておかない）。
     * デモが無ければ null、地図の口が無い・駅が地図に結び付かなければ undefined。
     */
    async searchStores(
      id: string,
      query: string,
      stationId: string,
    ): Promise<
      { status: 'ok'; stores: FoundStore[] } | { status: 'limit' | 'failed' } | null | undefined
    > {
      const session = touch(id);
      if (!session) return null;
      const client = deps.maps;
      if (!client) return undefined;
      if (session.storeSearches >= MAX_STORE_SEARCHES_PER_SESSION) return { status: 'limit' };
      const household = await store.withHousehold(id, (log) => foldEvents(log.events()).household);
      if (!household) return undefined;
      session.storeSearches += 1;
      try {
        const stores = await searchStores(household, client, query, stationId);
        return stores === undefined ? undefined : { status: 'ok', stores };
      } catch {
        return { status: 'failed' };
      }
    },
    /** 段から新しいデモの家庭を作る。 */
    create(stage: DemoStageId): string {
      sweep();
      const id = randomUUID();
      const now = DEMO_STAGES.find((s) => s.id === stage)?.now;
      if (!now) throw new Error(`デモの段が無い：${stage}`);
      store.create(id, demoEvents(stage));
      sessions.set(id, {
        now,
        touched: clock(),
        readings: 0,
        operations: new Map(),
        utterances: 0,
        photos: 0,
        photoOperations: new Map(),
        utteranceOperations: new Map(),
        wayIdeas: 0,
        wayIdeasOperations: new Map(),
        proposals: new Map(),
        storeKinds: 0,
        storeSearches: 0,
        surveys: 0,
        surveyOperations: new Map(),
        surveyed: new Map(),
      });
      return id;
    },
    async view(id: string, memberId: string): Promise<View | undefined> {
      const session = touch(id);
      if (!session) return undefined;
      const maps = await mapsOf(id);
      return store.withHousehold(id, (log) => demoView(log.events(), memberId, session.now, maps));
    },
    /** 決める画面の「選んだら」（何も書かない）。家庭が無ければ null、手配が無ければ undefined。 */
    async preview(
      id: string,
      memberId: string,
      arrangementKey: string,
    ): Promise<ChoicePreview[] | undefined | null> {
      const session = touch(id);
      if (!session) return null;
      const maps = await mapsOf(id);
      return store.withHousehold(id, (log) =>
        previewChoices(
          log.events(),
          { memberId, now: session.now, ...(maps ? { maps } : {}) },
          arrangementKey,
        ),
      );
    },
    /** 家と暮らしの情報の直しを、書き込まずに見る（previewChange）。会話が無ければ null。 */
    async householdPreview(
      id: string,
      memberId: string,
      household: Household,
    ): Promise<ReturnType<typeof previewChange> | null> {
      return this.changePreview(id, memberId, { type: 'updateHousehold', household });
    },
    /** 保存の前に「この変更で変わること」を見る（何も書かない）。会話が無ければ null。 */
    async changePreview(
      id: string,
      memberId: string,
      command: PreviewCommand,
    ): Promise<ReturnType<typeof previewChange> | null> {
      const session = touch(id);
      if (!session) return null;
      const maps = await mapsOf(id, proposedOf(command));
      return store.withHousehold(id, (log) =>
        previewChange(
          log.events(),
          {
            memberId,
            now: session.now,
            ...(maps ? { maps } : {}),
            surveyed: [...session.surveyed.values()],
          },
          command,
        ),
      );
    },
    async command(
      id: string,
      memberId: string,
      operationId: string,
      command: Command,
    ): Promise<{ result: CommandResult; view: View } | undefined> {
      const session = touch(id);
      if (!session) return undefined;
      const maps = await mapsOf(id, proposedOf(command));
      // 時計を進めたデモの時刻は、命令の処理が家庭を押さえた中で事象から決める（ここで先に読まない）。
      if (
        command.type === 'issueAnswerLink' &&
        (session.links?.size ?? 0) >= MAX_LINKS_PER_SESSION
      ) {
        const view = await store.withHousehold(id, (log) =>
          demoView(log.events(), memberId, session.now, maps),
        );
        return {
          result: { status: 'invalid', reason: 'tooManyLinks', throughSeq: view.plan.throughSeq },
          view,
        };
      }
      const result = await runCommand(
        store,
        id,
        {
          memberId,
          operationId,
          now: session.now,
          demo: true,
          ...(maps ? { maps } : {}),
          surveyed: [...session.surveyed.values()],
        },
        command,
      );
      // 出した鍵を表に足す（鍵そのものは置かない。sha256 から引く）。
      if (
        command.type === 'issueAnswerLink' &&
        'answerLink' in result &&
        result.answerLink &&
        alive(id, session)
      ) {
        const hash = answerTokenHash(result.answerLink.token);
        linkIndex.set(hash, {
          householdId: id,
          itemId: command.itemId,
          personId: result.answerLink.personId,
        });
        session.links = (session.links ?? new Set()).add(hash);
      }
      const view = await store.withHousehold(id, (log) =>
        demoView(log.events(), memberId, session.now, maps),
      );
      return { result, view };
    },
    /** 答えるリンクの頁に見せる物。鍵が効かなければ undefined、数の上限なら tooMany。 */
    async answerView(token: string): Promise<AnswerView | 'tooMany' | undefined> {
      const found = linkOf(token);
      if (found === undefined || found === 'tooMany') return found;
      const { hash, entry, session } = found;
      const view = await store
        .withHousehold(entry.householdId, (log) => answerView(log, entry, hash))
        .catch(() => undefined);
      if (view) session.touched = clock();
      return view;
    },
    /** 答えるリンクからの答えを書く。鍵が効かなければ undefined、数の上限なら tooMany。 */
    async answerSubmit(
      token: string,
      body: AnswerSubmit,
    ): Promise<AnswerResult | 'tooMany' | undefined> {
      const found = linkOf(token);
      if (found === undefined || found === 'tooMany') return found;
      const { hash, entry, session } = found;
      const result = await store
        .withHousehold(entry.householdId, (log) =>
          submitAnswer(log, entry, hash, body, session.now),
        )
        .catch(() => undefined);
      if (!result || result.status === 'unauthorized') return undefined;
      session.touched = clock();
      return result;
    },
    /**
     * 家族が貼った・話したお知らせの文を、Claude で読んで計画に入れる。読む間は家庭を押さえない
     * （待つ間も、他の画面を止めない）。数と同時に読む数を、ここで抑える。
     */
    /**
     * お知らせの写真・PDF を書き起こし、文を返す（何も記録しない。写真は残さない）。家族が写真と見比べて
     * 直してから、文として読む（notice）。
     */
    async photo(
      id: string,
      memberId: string,
      input: PhotoInput & { operationId: string },
      read: PhotoReader,
    ): Promise<PhotoResult | undefined> {
      const session = touch(id);
      if (!session) return undefined;
      const digest = createHash('sha256')
        .update(memberId)
        .update(input.mediaType)
        .update(input.data)
        .digest('hex');
      // 同じ操作の送り直しは、数の上限より先に見る（返事が届かなかった時も、同じ文を返す）。
      const previous = session.photoOperations.get(input.operationId);
      if (previous) {
        if (previous.digest !== digest) return { status: 'conflict' };
        return previous.result ?? { status: 'busy' };
      }
      const adult = await store.withHousehold(id, (log) =>
        foldEvents(log.events()).household?.members.some(
          (m) => m.id === memberId && m.kind === 'adult' && m.active,
        ),
      );
      // 確かめる間にデモが消えたら、数を使わず、外にも送らない。
      if (!alive(id, session)) return undefined;
      if (!adult) return { status: 'invalid' };
      const today = new Date(clock()).toISOString().slice(0, 10);
      if (daily.day !== today) Object.assign(daily, { day: today, count: 0 });
      if (session.photos >= MAX_PHOTOS_PER_SESSION || daily.count >= perDay) {
        return { status: 'limit' };
      }
      if (session.reading !== undefined || inFlight >= MAX_READINGS_IN_FLIGHT) {
        return { status: 'busy' };
      }
      // 数は、待つ前に押さえる（同じ時に来た二つが、どちらも上限の手前を見て進まないように）。
      session.photos += 1;
      daily.count += 1;
      session.reading = input.operationId;
      inFlight += 1;
      session.photoOperations.set(input.operationId, { digest });
      try {
        const result = await read({ mediaType: input.mediaType, data: input.data });
        // 待つ間にデモが消えた（期限切れ・追い出し）なら、結果を返さない（消えたデモの成功にしない）。
        if (!alive(id, session)) {
          session.photoOperations.delete(input.operationId);
          return undefined;
        }
        const done = { status: 'ok' as const, text: result.text };
        session.photoOperations.set(input.operationId, { digest, result: done });
        return done;
      } catch (error) {
        // 入力の見積もりが多すぎて書き起こしを呼ばなかった時も、見積もりで Anthropic に送ったので、数は
        // 戻さない（大きすぎる物を選び直し続けて、外への要求が上限なく増えないように）。同じ操作の送り直しには、
        // もう一度数えずに同じ答えを返す。
        if (error instanceof PhotoTooLarge) {
          const tooLarge = { status: 'tooLarge' as const };
          session.photoOperations.set(input.operationId, { digest, result: tooLarge });
          return tooLarge;
        }
        // 書き起こせなかった操作は控えを消す（同じ ID で、もう一度送れる）。数は戻さない（外への要求の数を抑える）。
        session.photoOperations.delete(input.operationId);
        return { status: 'failed', reason: error instanceof ReadingError ? error.reason : 'error' };
      } finally {
        session.reading = undefined;
        inFlight -= 1;
      }
    },
    async notice(
      id: string,
      memberId: string,
      input: NoticeInput,
      read: NoticeReader,
    ): Promise<NoticeResult | undefined> {
      const session = touch(id);
      if (!session) return undefined;
      const digest = createHash('sha256')
        .update(JSON.stringify([memberId, input.sender, input.text, input.medium ?? 'text']))
        .digest('hex');
      // 同じ操作の送り直しは、数の上限より先に見る（最後の一回の返事が届かなかった時も、結果を返す）。
      const previous = session.operations.get(input.operationId);
      if (previous) {
        if (previous.digest !== digest) return { status: 'conflict' };
        if (previous.state === 'reading' || !previous.sourceId || !previous.check) {
          return { status: 'busy' };
        }
        const { sourceId, check } = previous;
        const maps = await mapsOf(id);
        // 読み直さず、数えず、今の見せる物で答える。
        return store.withHousehold(id, (log) => ({
          status: 'ok' as const,
          view: demoView(log.events(), memberId, session.now, maps),
          sourceId,
          check,
        }));
      }
      const today = new Date(clock()).toISOString().slice(0, 10);
      if (daily.day !== today) Object.assign(daily, { day: today, count: 0 });
      if (session.readings >= MAX_READINGS_PER_SESSION || daily.count >= perDay) {
        return { status: 'limit' };
      }
      // 待つ間に重ねて呼ばない（同じデモの前の読み取りを、後の読み取りが知らずに読むのも防ぐ）。
      if (session.reading !== undefined || inFlight >= MAX_READINGS_IN_FLIGHT) {
        return { status: 'busy' };
      }
      // 数は、待つ前に押さえる（同じ時に来た二つが、どちらも上限の手前を見て進まないように）。
      // 呼ばずに終えた時（家族の大人でない・送る量が多すぎる）は返す。
      session.readings += 1;
      daily.count += 1;
      const day = daily.day;
      session.reading = input.operationId;
      inFlight += 1;
      session.operations.set(input.operationId, { digest, state: 'reading' });
      try {
        const result = await readNotice(id, session, memberId, input, digest, read);
        if (result?.status === 'invalid' || result?.status === 'limit') {
          session.readings -= 1;
          if (daily.day === day) daily.count -= 1;
        }
        return result;
      } finally {
        session.reading = undefined;
        inFlight -= 1;
        // 足さずに終えた操作は控えを消す（同じ ID で、もう一度読める）。
        if (session.operations.get(input.operationId)?.state === 'reading') {
          session.operations.delete(input.operationId);
        }
      }
    },
    /**
     * 家族の一言を Claude で読み、今の計画の、どの作業・頼み事・値のことかを候補にして返す。確かめる
     * までは何も書かない。数と同時に読む数は、お知らせと一緒に抑える。
     */
    async utterance(
      id: string,
      memberId: string,
      input: UtteranceInput,
      read: UtteranceReader,
    ): Promise<UtteranceOutcome | undefined> {
      const session = touch(id);
      if (!session) return undefined;
      const digest = createHash('sha256')
        .update(JSON.stringify([memberId, input.text]))
        .digest('hex');
      const previous = session.utteranceOperations.get(input.operationId);
      if (previous) {
        if (previous.digest !== digest) return { status: 'conflict' };
        if (previous.state === 'reading' || !previous.reply || !previous.context) {
          return { status: 'busy' };
        }
        const { reply, context } = previous;
        const maps = await mapsOf(id);
        // 読み直さず、数えずに同じ答えを返す。ただし、読んだ後に前提が変わっていれば、古い答えを
        // 今の計画と並べて見せない（新しい操作で読み直してもらう）。
        return store.withHousehold(id, (log): UtteranceOutcome => {
          const now = utteranceContext(log.events(), memberId, session.now, input.text, maps);
          if (!now || contextDigest(now) !== context) return { status: 'stale' };
          return { status: 'ok', view: demoView(log.events(), memberId, session.now, maps), reply };
        });
      }
      const today = new Date(clock()).toISOString().slice(0, 10);
      if (daily.day !== today) Object.assign(daily, { day: today, count: 0 });
      if (session.utterances >= MAX_UTTERANCES_PER_SESSION || daily.count >= perDay) {
        return { status: 'limit' };
      }
      if (session.reading !== undefined || inFlight >= MAX_READINGS_IN_FLIGHT) {
        return { status: 'busy' };
      }
      session.utterances += 1;
      daily.count += 1;
      const day = daily.day;
      session.reading = input.operationId;
      inFlight += 1;
      session.utteranceOperations.set(input.operationId, { digest, state: 'reading' });
      try {
        const result = await hear(id, session, memberId, input, digest, read);
        if (result?.status === 'invalid' || result?.status === 'limit') {
          session.utterances -= 1;
          if (daily.day === day) daily.count -= 1;
        }
        return result;
      } finally {
        session.reading = undefined;
        inFlight -= 1;
        if (session.utteranceOperations.get(input.operationId)?.state === 'reading') {
          session.utteranceOperations.delete(input.operationId);
        }
      }
    },
    /**
     * 新しい「すること」に、Claude がやり方の案を出す（何も書かない。家族が表で確かめて保存する）。数と同時に
     * 読む数は、お知らせ・一言と同じ枠で抑える。同じ操作 ID の送り直しは、作り直さずに同じ案を返す（前提が
     * 変わっていれば stale）。
     */
    async wayIdeas(
      id: string,
      memberId: string,
      input: WayIdeasInput,
      read: WayIdeasReader,
    ): Promise<WayIdeasOutcome | undefined> {
      const session = touch(id);
      if (!session) return undefined;
      const text = input.text?.trim() ?? '';
      const digest = createHash('sha256')
        .update(JSON.stringify(['way-ideas', memberId, input.arrangementKey, text, input.language]))
        .digest('hex');
      const previous = session.wayIdeasOperations.get(input.operationId);
      if (previous) {
        if (previous.digest !== digest) return { status: 'conflict' };
        if (previous.state === 'reading' || !previous.ideas || !previous.sent) {
          return { status: 'busy' };
        }
        const { ideas: shown, sent } = previous;
        return store.withHousehold(id, (log): WayIdeasOutcome => {
          const now = ideasContextOf(log.events(), memberId, session.now, input);
          if (now === 'invalid') return { status: 'invalid' };
          if (now === 'needGone') return { status: 'needGone' };
          if (JSON.stringify(now) !== JSON.stringify(sent)) return { status: 'stale' };
          return { status: 'ok', ideas: shown, sent };
        });
      }
      const today = new Date(clock()).toISOString().slice(0, 10);
      if (daily.day !== today) Object.assign(daily, { day: today, count: 0 });
      if (session.wayIdeas >= MAX_WAY_IDEAS_PER_SESSION || daily.count >= perDay) {
        return { status: 'limit' };
      }
      if (session.reading !== undefined || inFlight >= MAX_READINGS_IN_FLIGHT) {
        return { status: 'busy' };
      }
      session.wayIdeas += 1;
      daily.count += 1;
      const day = daily.day;
      session.reading = input.operationId;
      inFlight += 1;
      session.wayIdeasOperations.set(input.operationId, { digest, state: 'reading' });
      try {
        const result = await ideas(
          id,
          session,
          memberId,
          { ...input, ...(text ? { text } : {}) },
          digest,
          read,
        );
        // 呼ぶ前に断った物（家族の大人でない・手配が無い）は数えない。
        if (result?.status === 'invalid' || result?.status === 'needGone') {
          session.wayIdeas -= 1;
          if (daily.day === day) daily.count -= 1;
        }
        return result;
      } finally {
        session.reading = undefined;
        inFlight -= 1;
        if (session.wayIdeasOperations.get(input.operationId)?.state === 'reading') {
          session.wayIdeasOperations.delete(input.operationId);
        }
      }
    },
    /**
     * 家の周りの資源を調べる（何も書かない。家族が候補を確かめて、家の情報に入れる）。live でなければ、前に調べて
     * 記録した結果を見せる（この家の地域の物の時だけ。数えない）。live なら Claude にいま調べてもらう（数と、同時に
     * 読む数を抑える。同じ操作 ID の送り直しは、調べ直さずに同じ結果を返す）。どちらも、見せた候補をこのデモに
     * 控える（家族が入れる時に、送られた物と比べる）。
     */
    async survey(
      id: string,
      memberId: string,
      input: { operationId: string; live: boolean },
      read?: SurveyReader,
    ): Promise<SurveyOutcome | undefined> {
      const session = touch(id);
      if (!session) return undefined;
      const asked = await store.withHousehold(id, (log) => surveyInputOf(log.events(), memberId));
      if (asked === 'invalid' || asked === 'noArea') return { status: asked };
      const remember = (shown: SurveyShown) => {
        for (const c of shown.candidates) session.surveyed.set(c.id, c);
        return { status: 'ok' as const, survey: shown };
      };
      if (!input.live) {
        if (!recordedSurvey || recordedSurvey.area !== asked.area) return { status: 'noRecord' };
        return remember(recordedSurvey);
      }
      if (!read) return { status: 'failed', reason: 'unavailable' };
      const digest = createHash('sha256')
        .update(JSON.stringify(['survey', memberId, asked.area]))
        .digest('hex');
      const previous = session.surveyOperations.get(input.operationId);
      if (previous) {
        if (previous.digest !== digest) return { status: 'conflict' };
        return previous.survey ? remember(previous.survey) : { status: 'busy' };
      }
      const today = new Date(clock()).toISOString().slice(0, 10);
      if (dailySurveys.day !== today) Object.assign(dailySurveys, { day: today, count: 0 });
      if (session.surveys >= MAX_SURVEYS_PER_SESSION || dailySurveys.count >= surveysPerDay) {
        return { status: 'limit' };
      }
      if (session.reading !== undefined || inFlight >= MAX_READINGS_IN_FLIGHT) {
        return { status: 'busy' };
      }
      // 外に送る前に数える（失敗しても、呼んだ分は数える）。
      session.surveys += 1;
      dailySurveys.count += 1;
      session.reading = input.operationId;
      inFlight += 1;
      session.surveyOperations.set(input.operationId, { digest, state: 'reading' });
      try {
        let result: SurveyResult;
        try {
          result = await read(asked);
        } catch (error) {
          return {
            status: 'failed',
            reason: error instanceof ReadingError ? error.reason : 'error',
          };
        }
        if (!alive(id, session)) return undefined;
        const at = formatDateTime(Math.floor(clock() / 60_000), asked.timeZone);
        const checked = checkSurvey(
          result.output,
          result.pages,
          SURVEY_KINDS.map((k) => k.kind),
          surveyCandidateId,
          at,
        );
        const shown: SurveyShown = { area: asked.area, at, recorded: false, ...checked };
        session.surveyOperations.set(input.operationId, { digest, state: 'done', survey: shown });
        return remember(shown);
      } finally {
        session.reading = undefined;
        inFlight -= 1;
        if (session.surveyOperations.get(input.operationId)?.state === 'reading') {
          session.surveyOperations.delete(input.operationId);
        }
      }
    },
    /**
     * 見せた候補を記録する（本人だけ）。家庭を押さえた中で、候補の対象の今の状態を見せた時と比べ、
     * 違えば記録せずに見せ直す。同じ操作 ID の送り直しは、比べる前に済んだと答える。
     */
    async confirm(
      id: string,
      memberId: string,
      proposalId: string,
      operationId: string,
    ): Promise<ConfirmOutcome | undefined> {
      const session = touch(id);
      if (!session) return undefined;
      const proposal = session.proposals.get(proposalId);
      if (!proposal) return { status: 'gone' };
      if (proposal.memberId !== memberId) return { status: 'forbidden' };
      const maps = await mapsOf(id);
      // 見せた時に記録させないとした候補は、押されても記録しない（画面を通らない送りも同じ）。
      const guard: CommandGuard = (events) => {
        if (proposal.blocked) return 'proposalChanged';
        const now = utteranceContext(events, memberId, session.now, '', maps);
        const same =
          now !== undefined &&
          JSON.stringify(seenOf(proposal.command, now)) === JSON.stringify(proposal.seen);
        if (!same) return 'proposalChanged';
        // 見せた後に同じ種類の対象が増えた・時刻で替わった物は、家庭を押さえた中で、今の前提で判断し直す。
        const blocked = recordBlock(proposal.command, now, computePlan(events, session.now, maps), {
          trial: false,
        });
        return blocked ? 'proposalChanged' : undefined;
      };
      const result = await runCommand(
        store,
        id,
        { memberId, operationId, now: session.now, demo: true, ...(maps ? { maps } : {}) },
        proposal.command,
        guard,
      );
      const view = await store.withHousehold(id, (log) =>
        demoView(log.events(), memberId, session.now, maps),
      );
      if (result.status === 'ok' || result.status === 'noop') return { status: 'ok', view };
      if (result.status === 'conflict' && result.reason === 'proposalChanged') {
        return { status: 'changed', view };
      }
      return { status: 'refused', result, view };
    },
  };
}
