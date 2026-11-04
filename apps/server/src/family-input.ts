// 家族の家庭の文字の読み取りと一言。外への呼び出し中は家庭を押さえず、戻ってから身元と前提を
// もう一度確かめる。候補は本人が確かめるまで記録せず、読み取りは出典と一緒に一度だけ足す。
import { randomUUID } from 'node:crypto';
import {
  type Command,
  type DateTime,
  type DomainEvent,
  Extraction,
  ExtractionOutput,
  isNeedArrangementKey,
  type PlanResult,
  type ProposalSeen,
  type Source,
  type SourceSender,
  seenOf,
  splitSentences,
  taskContent,
  toExtraction,
  toUtteranceReply,
  UtteranceOutput,
} from '@maniau/core';
import { computePlan, currentItems, foldEvents } from '@maniau/core/engine';
import { and, count, eq, gte, like } from 'drizzle-orm';
import { nowIn } from './clock';
import { type CommandGuard, reopened, runCommand } from './commands';
import { households, operations } from './db/schema';
import {
  MAX_READING_INPUT_CHARS,
  MAX_READINGS_IN_FLIGHT,
  MAX_UTTERANCE_INPUT_CHARS,
  type NoticeReader,
  type ReadCheck,
  type ShownProposal,
  type ShownReply,
  type UtteranceReader,
} from './demo-sessions';
import { sha256Of } from './digest';
import type { FamilyMember } from './members';
import { buildExtractInput, type ExtractRequest, ReadingError } from './reading/extract';
import { buildUtteranceInput } from './reading/utterance';
import type { HouseholdLog, Store } from './store';
import { utteranceContext } from './utterance-context';
import { type View, viewFor } from './views';

const DAILY_LIMIT = 100;
const ACTIVE_MS = 120_000;
const TIMEOUT_MS = 115_000;
const PROPOSAL_TTL_MS = 30 * 60_000;
const MAX_PROPOSALS = 500;

type Failure =
  | {
      status:
        | 'forbidden'
        | 'testOnly'
        | 'conflict'
        | 'stale'
        | 'busy'
        | 'limit'
        | 'uncertain'
        | 'gone';
    }
  | { status: 'failed'; reason: string };

export type FamilyNoticeResult =
  | { status: 'ok'; sourceId: string; check: ReadCheck; view: View }
  | Failure;
export type FamilyUtteranceResult = { status: 'ok'; reply: ShownReply; view: View } | Failure;
export type FamilyConfirmResult = { status: 'ok'; view: View } | Failure;

interface FamilyInputOptions {
  store: Store;
  clock?: () => number;
  /** 試験で小さくできる。通算は Postgres の操作記録から数える。 */
  dailyLimit?: number;
  timeoutMs?: number;
  proposalTtlMs?: number;
}

interface Input {
  text: string;
  operationId: string;
}

interface NoticeInput extends Input {
  sender: SourceSender;
}

interface StoredProposal {
  householdId: string;
  memberId: string;
  identityId: string;
  command: Command;
  seen: ProposalSeen;
  expires: number;
}

type Recheck = () => Promise<boolean>;
type Outcome = 'ok' | 'failed' | 'stale' | 'forbidden';
class InputTimeout extends Error {}

const bound = (log: HouseholdLog, member: FamilyMember) =>
  log.isBound?.(member.memberId, member.identityId) === true;
/** 今週は、架空の test 家庭だけを外部の読み取りに使う。test の印は本文が架空である証明ではない。 */
async function testHousehold(log: HouseholdLog, member: FamilyMember): Promise<boolean> {
  if (!log.transaction) return false;
  const [household] = await log.transaction
    .select({ kind: households.kind })
    .from(households)
    .where(eq(households.id, member.householdId));
  return household?.kind === 'test';
}
const currentSeq = (events: readonly DomainEvent[]) => events.at(-1)?.seq ?? 0;
const operationKey = (member: FamilyMember, id: string) =>
  sha256Of([member.householdId, member.memberId, id]);
const startId = (key: string) => `family-input:start:${key}`;
const endId = (key: string) => `family-input:end:${key}`;
const confirmId = (key: string) => `family-input:confirm:${key}`;
const bindId = (key: string) => `family-input:proposal:${key}`;
const sourceIdFor = (member: FamilyMember, id: string) =>
  `u-${sha256Of([member.householdId, member.memberId, id]).slice(0, 32)}`;

function identity(member: FamilyMember) {
  return sha256Of([member.householdId, member.memberId, member.identityId]);
}

function titleOf(text: string): string | undefined {
  const first = text.trim().split(/\r?\n/)[0]?.trim();
  return first ? (first.length > 40 ? `${first.slice(0, 40)}…` : first) : undefined;
}

function schoolYearOf(at: DateTime): string {
  return String(Number(at.slice(0, 4)) - (Number(at.slice(5, 7)) < 4 ? 1 : 0));
}

/** 過去の依頼は、今の事項ではなく、送ったと記録した時の控えを一言の前提にする。 */
function familyUtteranceContext(
  events: readonly DomainEvent[],
  memberId: string,
  now: DateTime,
  text: string,
) {
  const context = utteranceContext(events, memberId, now, text);
  if (!context) return undefined;
  const plan = computePlan(events, now);
  return {
    ...context,
    requests: context.requests.map((request) => {
      const sent = plan.requests.find((entry) => entry.requestId === request.id);
      if (!sent || !isNeedArrangementKey(sent.basis.arrangementKey)) return request;
      const asked = sent.askedNeed;
      if (!asked) return { ...request, what: '記録した時の内容を確かめられない' };
      const details = [
        `記録した時の用件：${asked.what}`,
        ...(asked.step ? [`頼んだ手順：${asked.step.name}`] : []),
        ...(sent.window ? [`頼んだ時間：${sent.window.start}〜${sent.window.end}`] : []),
        ...(asked.deadline
          ? [`締切：${asked.deadlineDayOnly ? asked.deadline.slice(0, 10) : asked.deadline}`]
          : []),
        ...(asked.place ? [`場所：${asked.place}`] : []),
        ...(asked.forMemberId ? [`だれの分：${asked.forMemberId}`] : []),
      ];
      return { ...request, what: details.join('、') };
    }),
  };
}

/** 現行の一言候補と同じ、見せた時の対象と内容を命令に添える。 */
function withSeen(command: Command, plan: PlanResult, throughSeq: number): Command {
  if (command.type === 'recordSent') {
    const task = plan.tasks.find((entry) => entry.key === command.taskKey);
    const arrangement = plan.arrangements.find((entry) => entry.key === task?.basis.arrangementKey);
    return arrangement?.kind === 'childCare' ||
      (arrangement?.kind === 'need' && arrangement.needShape === 'window')
      ? { ...command, window: { start: arrangement.start, end: arrangement.end } }
      : command;
  }
  if (command.type === 'commitment' && command.action === 'done') {
    const task = plan.tasks.find((entry) => entry.key === command.taskKey);
    return task ? { ...command, seen: taskContent(task) } : command;
  }
  if (command.type === 'answer') {
    const what = plan.requirements.find(
      (entry) => entry.atHomeUnknownId === command.unknownId,
    )?.what;
    return { ...command, seen: what === undefined ? { throughSeq } : { what, throughSeq } };
  }
  return command;
}

/** 見せる候補は短時間だけメモリに置く。再起動後は消え、古い候補を黙って確定しない。 */
export function familyInput(options: FamilyInputOptions) {
  const { store } = options;
  const dailyLimit = options.dailyLimit ?? DAILY_LIMIT;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const proposalTtlMs = options.proposalTtlMs ?? PROPOSAL_TTL_MS;
  const proposals = new Map<string, StoredProposal>();
  const utteranceReplies = new Map<
    string,
    {
      digest: string;
      owner: string;
      reply: ShownReply;
      contextHash: string;
      at: DateTime;
      throughSeq: number;
      expires: number;
    }
  >();
  const active = new Set<string>();

  // 使わなくなった家庭も、次の要求を待たずに一言の候補をメモリから外す。
  const expire = <T extends { expires: number }>(
    entries: Map<string, T>,
    id: string,
    at: number,
  ) => {
    const timer = setTimeout(
      () => {
        if (entries.get(id)?.expires === at) entries.delete(id);
      },
      Math.max(0, at - Date.now()),
    );
    timer.unref();
  };

  const prune = () => {
    const now = Date.now();
    for (const [id, value] of proposals) if (value.expires <= now) proposals.delete(id);
    for (const [id, value] of utteranceReplies)
      if (value.expires <= now) utteranceReplies.delete(id);
    while (proposals.size > MAX_PROPOSALS) {
      const first = proposals.keys().next().value;
      if (!first) break;
      proposals.delete(first);
    }
    while (utteranceReplies.size > MAX_PROPOSALS) {
      const first = utteranceReplies.keys().next().value;
      if (!first) break;
      utteranceReplies.delete(first);
    }
  };

  /** 読む前に操作を永続的に予約する。再起動・応答不明でも同じ操作を自動で外へ送り直さない。 */
  async function reserve(
    member: FamilyMember,
    key: string,
    digest: string,
    make: (events: readonly DomainEvent[], at: DateTime) => unknown | undefined,
  ): Promise<
    | { status: 'start'; data: unknown; throughSeq: number; at: DateTime }
    | { status: 'finished'; outcome: Outcome }
    | Failure
  > {
    let acquired = false;
    try {
      const result = await store.withHousehold(member.householdId, async (log) => {
        if (!bound(log, member)) return { status: 'forbidden' } as const;
        if (!(await testHousehold(log, member))) return { status: 'testOnly' } as const;
        const previous = log.operation(startId(key));
        if (previous) {
          if (previous.actorId !== member.memberId || previous.digest !== digest)
            return { status: 'conflict' } as const;
          const finished = log.operation(endId(key));
          if (finished) {
            const outcome = finished.digest.split(':', 1)[0] as Outcome;
            return { status: 'finished', outcome } as const;
          }
          return { status: active.has(member.householdId) ? 'busy' : 'uncertain' } as const;
        }
        if (!log.transaction) return { status: 'failed', reason: 'store' } as const;
        const at = nowIn(member.timeZone, options.clock?.());
        const events = log.events();
        const data = make(events, at);
        if (data === undefined) return { status: 'limit' } as const;
        if (active.has(member.householdId) || active.size >= MAX_READINGS_IN_FLIGHT)
          return { status: 'busy' } as const;
        const midnight = new Date();
        midnight.setUTCHours(0, 0, 0, 0);
        const [total] = await log.transaction
          .select({ value: count() })
          .from(operations)
          .where(
            and(
              eq(operations.householdId, member.householdId),
              like(operations.opId, 'family-input:start:%'),
              gte(operations.createdAt, midnight),
            ),
          );
        if ((total?.value ?? 0) >= dailyLimit) return { status: 'limit' } as const;
        // 別プロセスも同じ家庭の行を押さえる。前の呼び出しが終わった印のない間は重ねない。
        const recent = await log.transaction
          .select({ id: operations.opId })
          .from(operations)
          .where(
            and(
              eq(operations.householdId, member.householdId),
              like(operations.opId, 'family-input:start:%'),
              gte(operations.createdAt, new Date(Date.now() - ACTIVE_MS)),
            ),
          );
        if (recent.some((row) => !log.operation(endId(row.id.slice('family-input:start:'.length)))))
          return { status: 'busy' } as const;
        // SQL を待つ間に、別の家庭の読み取りが始まることがある。
        if (active.has(member.householdId) || active.size >= MAX_READINGS_IN_FLIGHT)
          return { status: 'busy' } as const;
        const throughSeq = currentSeq(events);
        log.recordOperation({ id: startId(key), actorId: member.memberId, digest, throughSeq });
        active.add(member.householdId);
        acquired = true;
        return { status: 'start', data, throughSeq, at } as const;
      });
      return result;
    } catch {
      if (acquired) active.delete(member.householdId);
      return { status: 'failed', reason: 'store' };
    }
  }

  /** 失敗も終了として数え、同じ操作を黙って外へ再送しない。中身は操作表に置かない。 */
  async function finish(member: FamilyMember, key: string, digest: string, outcome: Outcome) {
    try {
      await store.withHousehold(member.householdId, (log) => {
        const started = log.operation(startId(key));
        if (!started || started.actorId !== member.memberId || started.digest !== digest) return;
        if (log.operation(endId(key))) return;
        log.recordOperation({
          id: endId(key),
          actorId: member.memberId,
          digest: `${outcome}:${digest}`,
          throughSeq: currentSeq(log.events()),
        });
      });
    } catch {
      // 終了を記録できなければ、同じ操作は結果不明のまま。自動で呼び直さない。
    }
  }

  /** 時間切れでも、元の呼び出しが終わるまでこのプロセスの同時数は戻さない。 */
  async function call<T>(member: FamilyMember, run: () => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(run);
    void pending.then(
      () => active.delete(member.householdId),
      () => active.delete(member.householdId),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new InputTimeout()), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const errorOf = (error: unknown) => (error instanceof ReadingError ? error.reason : 'error');

  /** 外へ送る直前にも身元と前提を確かめる。送った後に権限が外れた場合は、戻った結果を記録しない。 */
  async function beforeCall(
    member: FamilyMember,
    throughSeq: number,
    recheck: Recheck,
  ): Promise<'ok' | 'forbidden' | 'testOnly' | 'stale'> {
    if (!(await recheck())) return 'forbidden';
    return store.withHousehold(member.householdId, async (log) => {
      if (!bound(log, member)) return 'forbidden';
      if (!(await testHousehold(log, member))) return 'testOnly';
      return currentSeq(log.events()) === throughSeq ? 'ok' : 'stale';
    });
  }

  async function notice(
    member: FamilyMember,
    input: NoticeInput,
    read: NoticeReader,
    recheck: Recheck,
  ): Promise<FamilyNoticeResult> {
    const key = operationKey(member, input.operationId);
    const digest = sha256Of({ kind: 'notice', text: input.text, sender: input.sender });
    const sourceId = sourceIdFor(member, input.operationId);
    const reserved = await reserve(member, key, digest, (events, at) => {
      const state = foldEvents(events);
      const title = titleOf(input.text);
      const source: Source = {
        id: sourceId,
        version: 1,
        receivedAt: at,
        sender: input.sender,
        language: /[\u3040-\u30ff\u4e00-\u9fff]/.test(input.text) ? 'ja' : 'en',
        medium: 'text',
        ...(title ? { title } : {}),
        sentences: splitSentences(input.text, sourceId),
      };
      const request: ExtractRequest = {
        source,
        schoolYear: schoolYearOf(at),
        priorItems: currentItems(state).map((entry) => entry.item),
        priorUnknowns: [...state.extractions.values()]
          .filter((entry) => !state.withdrawnSources.has(entry.sourceId))
          .flatMap((entry) => entry.unknowns),
      };
      return buildExtractInput(request).length <= MAX_READING_INPUT_CHARS ? request : undefined;
    });
    if (reserved.status === 'finished') {
      if (reserved.outcome === 'stale') return { status: 'stale' };
      if (reserved.outcome !== 'ok') return { status: 'failed', reason: 'previous' };
      return store.withHousehold(member.householdId, async (log): Promise<FamilyNoticeResult> => {
        if (!bound(log, member)) return { status: 'forbidden' };
        if (!(await testHousehold(log, member))) return { status: 'testOnly' };
        const events = log.events();
        const end = log.operation(endId(key));
        const found = events.findLast(
          (event) =>
            event.type === 'modelOutputRecorded' &&
            event.call === 'extract' &&
            event.sourceId === sourceId &&
            end !== undefined &&
            event.seq <= end.throughSeq,
        );
        const latest = events.findLast(
          (event) =>
            event.type === 'modelOutputRecorded' &&
            event.call === 'extract' &&
            event.sourceId === sourceId,
        );
        const state = foldEvents(events);
        const source = state.sources.get(sourceId);
        if (state.purgedSources.get(sourceId) === 'all' || !source) return { status: 'uncertain' };
        if (
          state.withdrawnSources.has(sourceId) ||
          found?.type !== 'modelOutputRecorded' ||
          latest?.seq !== found.seq ||
          source.version !== found.sourceVersion
        )
          return { status: 'stale' };
        const parsed = Extraction.safeParse(found.output);
        if (!parsed.success || parsed.data.sourceId !== sourceId) return { status: 'uncertain' };
        const extraction = parsed.data;
        return {
          status: 'ok',
          sourceId,
          check: {
            sentenceIds: extraction.checkSentenceIds ?? [],
            all: extraction.checkAll ?? false,
          },
          view: viewFor(events, member.memberId, nowIn(member.timeZone, options.clock?.())),
        };
      });
    }
    if (reserved.status !== 'start') return reserved;
    const request = reserved.data as ExtractRequest;
    let started = false;
    let writing = false;
    try {
      const ready = await beforeCall(member, reserved.throughSeq, recheck);
      if (ready !== 'ok') {
        active.delete(member.householdId);
        await finish(member, key, digest, ready === 'testOnly' ? 'forbidden' : ready);
        return { status: ready };
      }
      started = true;
      const result = await call(member, () => read(request));
      const output = ExtractionOutput.parse(result.output);
      const { extraction } = toExtraction(output, request.source, {
        priorItems: request.priorItems,
        priorUnknowns: request.priorUnknowns,
      });
      if (!(await recheck())) {
        await finish(member, key, digest, 'forbidden');
        return { status: 'forbidden' };
      }
      // 書き込みの応答が失われると、コミット済みかは例外だけでは分からない。同じ操作で確かめる。
      writing = true;
      const done = await store.withHousehold(
        member.householdId,
        async (log): Promise<FamilyNoticeResult> => {
          if (!bound(log, member)) return { status: 'forbidden' };
          if (!(await testHousehold(log, member))) return { status: 'testOnly' };
          if (currentSeq(log.events()) !== reserved.throughSeq) return { status: 'stale' };
          const now = nowIn(member.timeZone, options.clock?.());
          const before = computePlan(log.events(), now);
          log.append(
            [{ type: 'noticeReceived', source: request.source }],
            member.memberId,
            reserved.at,
          );
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
            now,
          );
          const back = reopened(before, computePlan(log.events(), now));
          if (back.length > 0) log.append(back, 'system', now);
          log.recordOperation({
            id: endId(key),
            actorId: member.memberId,
            digest: `ok:${digest}`,
            throughSeq: currentSeq(log.events()),
          });
          return {
            status: 'ok',
            sourceId,
            check: {
              sentenceIds: extraction.checkSentenceIds ?? [],
              all: extraction.checkAll ?? false,
            },
            view: viewFor(log.events(), member.memberId, now),
          };
        },
      );
      writing = false;
      if (done.status === 'stale' || done.status === 'forbidden' || done.status === 'testOnly')
        await finish(member, key, digest, done.status === 'testOnly' ? 'forbidden' : done.status);
      return done;
    } catch (error) {
      if (!started) active.delete(member.householdId);
      if (error instanceof InputTimeout) return { status: 'uncertain' };
      if (writing) return { status: 'failed', reason: 'store' };
      await finish(member, key, digest, 'failed');
      return { status: 'failed', reason: errorOf(error) };
    }
  }

  async function utterance(
    member: FamilyMember,
    input: Input,
    read: UtteranceReader,
    recheck: Recheck,
  ): Promise<FamilyUtteranceResult> {
    prune();
    const key = operationKey(member, input.operationId);
    const digest = sha256Of({ kind: 'utterance', text: input.text });
    const reserved = await reserve(member, key, digest, (events, at) => {
      const context = familyUtteranceContext(events, member.memberId, at, input.text);
      return context && buildUtteranceInput(context).length <= MAX_UTTERANCE_INPUT_CHARS
        ? context
        : undefined;
    });
    if (reserved.status === 'finished') {
      if (reserved.outcome === 'stale') return { status: 'stale' };
      if (reserved.outcome !== 'ok') return { status: 'failed', reason: 'previous' };
      const cached = utteranceReplies.get(key);
      if (!cached || cached.owner !== identity(member) || cached.digest !== digest)
        return { status: 'uncertain' };
      return store.withHousehold(
        member.householdId,
        async (log): Promise<FamilyUtteranceResult> => {
          if (!bound(log, member)) return { status: 'forbidden' };
          if (!(await testHousehold(log, member))) return { status: 'testOnly' };
          const now = nowIn(member.timeZone, options.clock?.());
          const context = familyUtteranceContext(
            log.events(),
            member.memberId,
            cached.at,
            input.text,
          );
          if (
            !context ||
            currentSeq(log.events()) !== cached.throughSeq ||
            sha256Of(context) !== cached.contextHash
          )
            return { status: 'stale' };
          return {
            status: 'ok',
            reply: cached.reply,
            view: viewFor(log.events(), member.memberId, now),
          };
        },
      );
    }
    if (reserved.status !== 'start') return reserved;
    const context = reserved.data as NonNullable<ReturnType<typeof familyUtteranceContext>>;
    let started = false;
    let writing = false;
    try {
      const ready = await beforeCall(member, reserved.throughSeq, recheck);
      if (ready !== 'ok') {
        active.delete(member.householdId);
        await finish(member, key, digest, ready === 'testOnly' ? 'forbidden' : ready);
        return { status: ready };
      }
      started = true;
      const result = await call(member, () => read(context));
      const output = UtteranceOutput.parse(result.output);
      if (output.actions.length > 20) throw new Error('tooManyProposals');
      const reply = toUtteranceReply(output, context, randomUUID);
      if (!(await recheck())) {
        await finish(member, key, digest, 'forbidden');
        return { status: 'forbidden' };
      }
      // 候補と操作の記録が残ったか分からない時は、同じ操作で確かめる。
      writing = true;
      const done = await store.withHousehold(
        member.householdId,
        async (log): Promise<FamilyUtteranceResult> => {
          if (!bound(log, member)) return { status: 'forbidden' };
          if (!(await testHousehold(log, member))) return { status: 'testOnly' };
          const now = nowIn(member.timeZone, options.clock?.());
          // 読む時と同じ時刻で前提を照らす。時間の経過による有効性は候補を確かめる時に改めて見る。
          const current = familyUtteranceContext(
            log.events(),
            member.memberId,
            reserved.at,
            input.text,
          );
          if (
            !current ||
            currentSeq(log.events()) !== reserved.throughSeq ||
            sha256Of(current) !== sha256Of(context)
          )
            return { status: 'stale' };
          const view = viewFor(log.events(), member.memberId, now);
          const show = (proposal: { command: Command; seen: ProposalSeen }): ShownProposal => {
            const id = randomUUID();
            const command = withSeen(proposal.command, view.plan, reserved.throughSeq);
            const expires = Date.now() + proposalTtlMs;
            proposals.set(id, {
              householdId: member.householdId,
              memberId: member.memberId,
              identityId: member.identityId,
              command,
              seen: proposal.seen,
              expires,
            });
            expire(proposals, id, expires);
            const label =
              command.type === 'answer'
                ? context.unknowns.find((entry) => entry.id === command.unknownId)?.label
                : undefined;
            return { id, command, ...(label ? { label } : {}) };
          };
          let shown: ShownReply;
          if (reply.kind === 'change')
            shown = { kind: 'change', proposals: reply.proposals.map(show) };
          else if (reply.kind === 'clarify')
            shown = { ...reply, proposals: reply.proposals.map(show) };
          else shown = reply;
          log.recordOperation({
            id: endId(key),
            actorId: member.memberId,
            digest: `ok:${digest}`,
            throughSeq: currentSeq(log.events()),
          });
          const expires = Date.now() + proposalTtlMs;
          utteranceReplies.set(key, {
            digest,
            owner: identity(member),
            reply: shown,
            contextHash: sha256Of(context),
            at: reserved.at,
            throughSeq: reserved.throughSeq,
            expires,
          });
          expire(utteranceReplies, key, expires);
          prune();
          return { status: 'ok', reply: shown, view };
        },
      );
      writing = false;
      if (done.status === 'stale' || done.status === 'forbidden' || done.status === 'testOnly')
        await finish(member, key, digest, done.status === 'testOnly' ? 'forbidden' : done.status);
      return done;
    } catch (error) {
      if (!started) active.delete(member.householdId);
      if (error instanceof InputTimeout) return { status: 'uncertain' };
      if (writing) return { status: 'failed', reason: 'store' };
      await finish(member, key, digest, 'failed');
      return { status: 'failed', reason: errorOf(error) };
    }
  }

  async function confirm(
    member: FamilyMember,
    proposalId: string,
    operationId: string,
  ): Promise<FamilyConfirmResult> {
    prune();
    const proposal = proposals.get(proposalId);
    const key = operationKey(member, operationId);
    const proposalHash = sha256Of(proposalId);
    const prepared = await store.withHousehold(member.householdId, async (log) => {
      if (!bound(log, member)) return { status: 'forbidden' } as const;
      if (!(await testHousehold(log, member))) return { status: 'testOnly' } as const;
      const old = log.operation(bindId(key));
      const [boundProposal, boundCommand, extra] = old?.digest.split(':') ?? [];
      if (
        old &&
        (old.actorId !== member.memberId ||
          boundProposal !== proposalHash ||
          !/^[a-f0-9]{64}$/.test(boundCommand ?? '') ||
          extra !== undefined)
      )
        return { status: 'conflict' } as const;
      const previous = log.operation(confirmId(key));
      if (previous)
        return old && previous.actorId === member.memberId && previous.digest === boundCommand
          ? ({ status: 'already' } as const)
          : ({ status: 'conflict' } as const);
      if (!proposal) return { status: 'gone' } as const;
      if (
        proposal.householdId !== member.householdId ||
        proposal.memberId !== member.memberId ||
        proposal.identityId !== member.identityId
      )
        return { status: 'forbidden' } as const;
      const commandHash = sha256Of(proposal.command);
      if (old && boundCommand !== commandHash) return { status: 'conflict' } as const;
      if (!old)
        log.recordOperation({
          id: bindId(key),
          actorId: member.memberId,
          digest: `${proposalHash}:${commandHash}`,
          throughSeq: currentSeq(log.events()),
        });
      return { status: 'ready' } as const;
    });
    if (prepared.status !== 'ready' && prepared.status !== 'already') return prepared;
    if (prepared.status === 'ready' && proposal) {
      const now = nowIn(member.timeZone, options.clock?.());
      const guard: CommandGuard = (events) => {
        const current = familyUtteranceContext(events, member.memberId, now, '');
        return current && sha256Of(seenOf(proposal.command, current)) === sha256Of(proposal.seen)
          ? undefined
          : 'proposalChanged';
      };
      const result = await runCommand(
        store,
        member.householdId,
        {
          memberId: member.memberId,
          identityId: member.identityId,
          operationId: confirmId(key),
          now,
          demo: false,
        },
        proposal.command,
        guard,
      );
      if (result.status === 'conflict') return { status: 'stale' };
      if (result.status === 'forbidden') return { status: 'forbidden' };
      if (result.status === 'invalid') return { status: 'stale' };
    }
    return store.withHousehold(member.householdId, async (log): Promise<FamilyConfirmResult> => {
      if (!bound(log, member)) return { status: 'forbidden' };
      if (!(await testHousehold(log, member))) return { status: 'testOnly' };
      return {
        status: 'ok',
        view: viewFor(log.events(), member.memberId, nowIn(member.timeZone, options.clock?.())),
      };
    });
  }

  const canUse = (member: FamilyMember) =>
    store.withHousehold(member.householdId, async (log) =>
      bound(log, member) ? testHousehold(log, member) : false,
    );

  return { notice, utterance, confirm, canUse };
}
