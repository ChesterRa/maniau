// デモの家庭（ログインの無い、架空の家族）。見る人ごとに、段の事象から作った家庭をメモリに置く。
// 一人の操作が、別の人の見るデモを変えないようにする。古い物から捨てる。
import { createHash, randomUUID } from 'node:crypto';
import {
  type ChoicePreview,
  type Command,
  type DateTime,
  type DomainEvent,
  type Extraction,
  formatDateTime,
  type PlanResult,
  type ProposalSeen,
  type Source,
  type SourceSender,
  seenOf,
  splitSentences,
  toExtraction,
  toUtteranceReply,
  type UnsupportedReason,
  type UtteranceContext,
  type UtteranceRefs,
  type UtteranceReply,
} from '@maniau/core';
import { computePlan, currentItems, foldEvents } from '@maniau/core/engine';
import { type CommandGuard, type CommandResult, reopened, runCommand } from './commands';
import { DEMO_STAGES, type DemoStageId, demoEvents } from './demo';
import { previewChoices } from './preview';
import {
  buildExtractInput,
  type ExtractRequest,
  type ExtractResult,
  ReadingError,
} from './reading/extract';
import { type PhotoInput, PhotoTooLarge, type TranscribeResult } from './reading/transcribe';
import { buildUtteranceInput, type UtteranceResult } from './reading/utterance';
import { memoryStore } from './store';
import { utteranceContext } from './utterance-context';
import { type View, viewFor } from './views';

const MAX_SESSIONS = 200;
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
}

export type ShownReply =
  | { kind: 'change'; proposals: ShownProposal[] }
  | {
      kind: 'clarify';
      proposals: ShownProposal[];
      reason: 'ambiguous' | 'otherAdultsTask' | 'unowned';
      unowned?: true;
    }
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
}

interface Session {
  now: DateTime;
  touched: number;
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
  /** 見せた候補（確かめるまで、何も書かない）。 */
  proposals: Map<string, StoredProposal>;
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

export function demoSessions(
  clock: () => number = Date.now,
  /** 試験で数の上限を小さくする。 */
  limits: { perDay?: number } = {},
) {
  const perDay = limits.perDay ?? MAX_READINGS_PER_DAY;
  const store = memoryStore();
  const sessions = new Map<string, Session>();
  /** 今日（サーバーの時計の日付）読んだ数。 */
  const daily = { day: '', count: 0 };
  /** いま読んでいる数（サーバー全体）。 */
  let inFlight = 0;

  const sweep = () => {
    const now = clock();
    for (const [id, session] of sessions) {
      if (now - session.touched > TTL_MS) {
        sessions.delete(id);
        store.drop(id);
      }
    }
    while (sessions.size >= MAX_SESSIONS) {
      // 読んでいる途中のデモは追い出さない（外に送った後の結果を捨てず、後の段の呼び出しも無駄にしない）。
      // 途中の物は同時に読む数までなので、上限を少し超えるだけ。
      const oldest = [...sessions.entries()]
        .filter(([, s]) => s.reading === undefined)
        .sort((a, b) => a[1].touched - b[1].touched)[0];
      if (!oldest) break;
      sessions.delete(oldest[0]);
      store.drop(oldest[0]);
    }
  };

  // 誰も触らなくても掃除する。プロセスの終わりは止めない。
  setInterval(sweep, SWEEP_MS).unref();

  // 期限を過ぎたデモは、作る時の掃除を待たずに、触った時にも捨てる。
  const touch = (id: string) => {
    const session = sessions.get(id);
    if (!session) return undefined;
    if (clock() - session.touched > TTL_MS) {
      sessions.delete(id);
      store.drop(id);
      return undefined;
    }
    session.touched = clock();
    return session;
  };
  // 待つ間に、期限が切れた・数の上限で捨てたデモではないか（外に送る前と、結果を足す前に確かめる）。
  const alive = (id: string, session: Session) =>
    sessions.get(id) === session && clock() - session.touched <= TTL_MS;

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
    // 足す途中で投げたら（形の合わない記録など）、置き場所が全部を戻す。読めなかったとして返す。
    return store
      .withHousehold(id, (log): NoticeResult | undefined => {
        if (gone()) return undefined;
        // 読む間に前提が変わったら（家族が事項を直した等）、古い前提の読み取りを足さない（直した事を
        // 古い読み取りの作用で消さない）。読み直してもらう。
        // 読む間に大人でなくなった時も、前提が変わったとする（呼んだ分は数えたまま）。
        const now = contextOf(log.events(), memberId, session.now);
        if (!now || JSON.stringify(now) !== JSON.stringify(prior)) return { status: 'stale' };
        const before = computePlan(log.events(), session.now);
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
        const back = reopened(before, computePlan(log.events(), session.now));
        if (back.length > 0) log.append(back, 'system', prior.at);
        const view = viewFor(log.events(), memberId, session.now);
        // 足し終えてから、操作を済みにする（途中で投げて戻した時に、済みと答えない）。
        session.operations.set(input.operationId, { digest, state: 'done', sourceId, check });
        return { status: 'ok', view, sourceId, check };
      })
      .catch((): NoticeResult => ({ status: 'failed', reason: 'error' }));
  }

  /**
   * 候補の命令に、前提で見せた物を付ける：済んだには作業の今の用件、家にあるかの答えには品物、送ったには
   * 頼む時間（子の居場所の手配の区間）（命令は見せた物を必ず持つ。押すまでに直されて別の物になっていれば、
   * サーバーが断る）。
   */
  // 家にあるかの答えには、モデルに渡した前提が見ていた事象の位置を付ける（その後に入った答えを、古い
  // 候補で上書きしない。札と同じ確かめ）。
  const withSeen = (command: Command, plan: PlanResult, throughSeq: number): Command => {
    if (command.type === 'recordSent') {
      const task = plan.tasks.find((t) => t.key === command.taskKey);
      const arrangement = plan.arrangements.find((a) => a.key === task?.basis.arrangementKey);
      return arrangement?.kind === 'childCare'
        ? { ...command, window: { start: arrangement.start, end: arrangement.end } }
        : command;
    }
    if (command.type === 'commitment' && command.action === 'done') {
      const task = plan.tasks.find((t) => t.key === command.taskKey);
      return task
        ? { ...command, seen: { titleKey: task.titleKey, titleParams: task.titleParams } }
        : command;
    }
    if (command.type === 'answer') {
      const what = plan.requirements.find((r) => r.atHomeUnknownId === command.unknownId)?.what;
      return what === undefined ? command : { ...command, seen: { what, throughSeq } };
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
    if (reply.kind === 'question' || reply.kind === 'unsupported') return reply;
    const proposals = reply.proposals.map((p): ShownProposal => {
      const id = randomUUID();
      const command = withSeen(p.command, plan, throughSeq);
      session.proposals.set(id, { memberId, command, seen: p.seen });
      const label =
        command.type === 'answer'
          ? context.unknowns.find((u) => u.id === command.unknownId)?.label
          : undefined;
      return { id, command, ...(label ? { label } : {}) };
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
  async function hear(
    id: string,
    session: Session,
    memberId: string,
    input: UtteranceInput,
    digest: string,
    read: UtteranceReader,
  ): Promise<UtteranceOutcome | undefined> {
    const heardOn = await store.withHousehold(id, (log) => {
      const events = log.events();
      const context = utteranceContext(events, memberId, session.now, input.text);
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
        const now = utteranceContext(events, memberId, session.now, input.text);
        if (!now || JSON.stringify(now) !== JSON.stringify(context)) return { status: 'stale' };
        const view = viewFor(log.events(), memberId, session.now);
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
        proposals: new Map(),
      });
      return id;
    },
    async view(id: string, memberId: string): Promise<View | undefined> {
      const session = touch(id);
      if (!session) return undefined;
      return store.withHousehold(id, (log) => viewFor(log.events(), memberId, session.now));
    },
    /** 決める画面の「選んだら」（何も書かない）。家庭が無ければ null、手配が無ければ undefined。 */
    async preview(
      id: string,
      memberId: string,
      arrangementKey: string,
    ): Promise<ChoicePreview[] | undefined | null> {
      const session = touch(id);
      if (!session) return null;
      return store.withHousehold(id, (log) =>
        previewChoices(log.events(), { memberId, now: session.now }, arrangementKey),
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
      // 時計を進めたデモの時刻は、命令の処理が家庭を押さえた中で事象から決める（ここで先に読まない）。
      const result = await runCommand(
        store,
        id,
        { memberId, operationId, now: session.now, demo: true },
        command,
      );
      const view = await store.withHousehold(id, (log) =>
        viewFor(log.events(), memberId, session.now),
      );
      return { result, view };
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
        // 読み直さず、数えず、今の見せる物で答える。
        return store.withHousehold(id, (log) => ({
          status: 'ok' as const,
          view: viewFor(log.events(), memberId, session.now),
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
        // 読み直さず、数えずに同じ答えを返す。ただし、読んだ後に前提が変わっていれば、古い答えを
        // 今の計画と並べて見せない（新しい操作で読み直してもらう）。
        return store.withHousehold(id, (log): UtteranceOutcome => {
          const now = utteranceContext(log.events(), memberId, session.now, input.text);
          if (!now || contextDigest(now) !== context) return { status: 'stale' };
          return { status: 'ok', view: viewFor(log.events(), memberId, session.now), reply };
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
      const guard: CommandGuard = (events) => {
        const now = utteranceContext(events, memberId, session.now, '');
        const same =
          now !== undefined &&
          JSON.stringify(seenOf(proposal.command, now)) === JSON.stringify(proposal.seen);
        return same ? undefined : 'proposalChanged';
      };
      const result = await runCommand(
        store,
        id,
        { memberId, operationId, now: session.now, demo: true },
        proposal.command,
        guard,
      );
      const view = await store.withHousehold(id, (log) =>
        viewFor(log.events(), memberId, session.now),
      );
      if (result.status === 'ok' || result.status === 'noop') return { status: 'ok', view };
      if (result.status === 'conflict' && result.reason === 'proposalChanged') {
        return { status: 'changed', view };
      }
      return { status: 'refused', result, view };
    },
  };
}
