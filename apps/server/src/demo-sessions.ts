// デモの家庭（ログインの無い、架空の家族）。見る人ごとに、段の事象から作った家庭をメモリに置く。
// 一人の操作が、別の人の見るデモを変えないようにする。古い物から捨てる。
import { createHash, randomUUID } from 'node:crypto';
import {
  type Command,
  type DateTime,
  type DomainEvent,
  type Extraction,
  formatDateTime,
  type Source,
  type SourceSender,
  splitSentences,
  toExtraction,
} from '@maniau/core';
import { currentItems, foldEvents } from '@maniau/core/engine';
import { type CommandResult, runCommand } from './commands';
import { DEMO_STAGES, type DemoStageId, demoEvents } from './demo';
import {
  buildExtractInput,
  type ExtractRequest,
  type ExtractResult,
  ReadingError,
} from './reading/extract';
import { memoryStore } from './store';
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

/** 読み取りで、家族に確かめてほしい所（原文の文。どの文か分からない時は全体）。 */
export interface ReadCheck {
  sentenceIds: string[];
  all: boolean;
}

export interface NoticeInput {
  text: string;
  sender: SourceSender;
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

interface Session {
  now: DateTime;
  touched: number;
  /** このデモで読んだ（読もうとした）お知らせの数。 */
  readings: number;
  /** いま読んでいる操作の ID。 */
  reading?: string;
  operations: Map<string, ReadingOperation>;
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
      const oldest = [...sessions.entries()].sort((a, b) => a[1].touched - b[1].touched)[0];
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
    if (!prior) return { status: 'invalid' };
    const sourceId = `u${session.readings}`;
    const title = titleOf(input.text);
    const source: Source = {
      id: sourceId,
      version: 1,
      receivedAt: prior.at,
      sender: input.sender,
      language: languageOf(input.text),
      medium: 'text',
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
    const gone = () => sessions.get(id) !== session || clock() - session.touched > TTL_MS;
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
        const view = viewFor(log.events(), memberId, session.now);
        // 足し終えてから、操作を済みにする（途中で投げて戻した時に、済みと答えない）。
        session.operations.set(input.operationId, { digest, state: 'done', sourceId, check });
        return { status: 'ok', view, sourceId, check };
      })
      .catch((): NoticeResult => ({ status: 'failed', reason: 'error' }));
  }

  return {
    /** 段から新しいデモの家庭を作る。 */
    create(stage: DemoStageId): string {
      sweep();
      const id = randomUUID();
      const now = DEMO_STAGES.find((s) => s.id === stage)?.now;
      if (!now) throw new Error(`デモの段が無い：${stage}`);
      store.create(id, demoEvents(stage));
      sessions.set(id, { now, touched: clock(), readings: 0, operations: new Map() });
      return id;
    },
    async view(id: string, memberId: string): Promise<View | undefined> {
      const session = touch(id);
      if (!session) return undefined;
      return store.withHousehold(id, (log) => viewFor(log.events(), memberId, session.now));
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
    async notice(
      id: string,
      memberId: string,
      input: NoticeInput,
      read: NoticeReader,
    ): Promise<NoticeResult | undefined> {
      const session = touch(id);
      if (!session) return undefined;
      const digest = createHash('sha256')
        .update(JSON.stringify([memberId, input.sender, input.text]))
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
  };
}
