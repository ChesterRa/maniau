// 命令（02-foundation §7.2・§7.3）。画面は事象を直接書かず、命令を送る。サーバーが、権限と前提を
// 確かめて事象に展開する。一つの命令は、家庭を押さえた一続きの中で処理する。
import {
  type Command,
  type DateTime,
  type DomainEvent,
  formatDateTime,
  type PlanResult,
  proposalSnapshot,
  sameProposal,
  toEpochMinutes,
} from '@maniau/core';
import {
  type EngineState,
  foldEvents,
  itemsOf,
  planFromState,
  requestSnapshot,
  retiredUnknowns,
} from '@maniau/core/engine';
import { sha256Of } from './digest';
import type { EventBody, HouseholdLog, Store } from './store';

export interface CommandContext {
  /** 確かめた身元の成員（§7.3 の 1。身元の確かめは、この前に済ませる）。 */
  memberId: string;
  /** 操作 ID（画面が作る。送り直しても同じ）。 */
  operationId: string;
  now: DateTime;
  /** デモの家庭か（時計を進めてよい）。 */
  demo: boolean;
  /** 身元で入った命令なら、その身元（押さえた中で、今も結ばれているかを確かめる）。 */
  identityId?: string;
}

export type CommandResult =
  | { status: 'ok' | 'noop'; throughSeq: number }
  /** 見た物が古い（提案が変わった等）。新しい計画を見せて、本人に見直してもらう（409）。 */
  | { status: 'conflict'; reason: string; throughSeq: number }
  | { status: 'forbidden' | 'invalid'; reason: string; throughSeq: number };

/**
 * 命令の前に、押さえた中で見る物（見せた時の状態と今が同じか等）。違えば、断る理由を返す。
 * 操作 ID の送り直しは、この前に答える（済んだ操作の送り直しを、状態が変わったとして断らない）。
 */
export type CommandGuard = (events: readonly DomainEvent[]) => string | undefined;

/** 命令を処理する（§7.3）。家庭を押さえ、身元を確かめ直し、操作 ID を引き、前提を確かめて事象を足す。 */
export function runCommand(
  store: Store,
  householdId: string,
  context: CommandContext,
  command: Command,
  guard?: CommandGuard,
): Promise<CommandResult> {
  return store.withHousehold(householdId, (log) => handle(log, context, command, guard));
}

function handle(
  log: HouseholdLog,
  context: CommandContext,
  command: Command,
  guard?: CommandGuard,
): CommandResult {
  const events = log.events();
  const throughSeq = () => log.events().at(-1)?.seq ?? 0;
  const state = foldEvents(events);
  const household = state.household;
  // 押さえた後に、その成員が今も有効な大人かを確かめ直す（§7.3 の 3）。
  // 成員の表のある置き場所では、その表でも確かめる（権限の正本。§6.1）。身元で入った命令は、その
  // 身元が今も、この大人に結ばれているかも確かめる（確かめられない置き場所では断る）。
  const member = household?.members.find((m) => m.id === context.memberId);
  const allowed =
    (log.isActiveAdult ? log.isActiveAdult(context.memberId) : true) &&
    (context.identityId === undefined ||
      (log.isBound?.(context.memberId, context.identityId) ?? false));
  if (!household || !member || member.kind !== 'adult' || !member.active || !allowed) {
    return { status: 'forbidden', reason: 'notAnActiveAdult', throughSeq: throughSeq() };
  }
  // 同じ操作 ID：同じ人・同じ中身なら何も足さない。違えば衝突（§7.3 の 4）。操作の記録には命令の
  // 本文を置かず、要約（ハッシュ）だけを置く（直した文や答えの値を、中身の分け方の外に残さない）。
  const digest = sha256Of(command);
  const previous = log.operation(context.operationId);
  if (previous) {
    return previous.actorId === context.memberId && previous.digest === digest
      ? { status: 'noop', throughSeq: throughSeq() }
      : { status: 'conflict', reason: 'operationIdReused', throughSeq: throughSeq() };
  }
  const refused = guard?.(events);
  if (refused !== undefined)
    return { status: 'conflict', reason: refused, throughSeq: throughSeq() };
  // デモの家庭で時計を進めていれば、その時刻で処理する。押さえた中で事象から決めるので、並んで
  // 届いた命令でも、時計を進めた後の事象に前の時刻が付くことはない。
  const now =
    state.clock === undefined ? context.now : formatDateTime(state.clock, household.timeZone);
  const at = { ...context, now };
  const plan = planFromState(state, now);
  const decided = expand({ plan, state, events }, at, command);
  if ('reason' in decided) return { ...decided, throughSeq: throughSeq() };
  if (decided.bodies.length > 0) log.append(decided.bodies, context.memberId, now);
  // 何も起きなかった操作も残す（同じ操作の送り直しで、後の別の人の変更を戻さないため。§7.3 の 7）。
  log.recordOperation({
    id: context.operationId,
    actorId: context.memberId,
    digest,
    throughSeq: throughSeq(),
  });
  return { status: decided.bodies.length > 0 ? 'ok' : 'noop', throughSeq: throughSeq() };
}

type Expanded =
  | { bodies: EventBody[] }
  | { status: 'conflict' | 'forbidden' | 'invalid'; reason: string };

interface Now {
  plan: PlanResult;
  state: EngineState;
  events: readonly DomainEvent[];
}

/** 権限（§7.2）と前提を確かめ、命令を事象に展開する。 */
function expand({ plan, state, events }: Now, context: CommandContext, command: Command): Expanded {
  const me = context.memberId;
  const taskOf = (key: string) => plan.tasks.find((t) => t.key === key);
  const requestOf = (id: string) => plan.requests.find((r) => r.requestId === id);
  switch (command.type) {
    case 'answer': {
      // 答えられるのは、今の読み取りにある未定の値か、計画の問いの値だけ（宣言の値の中から）。
      // 取り下げた・消した出典の未定の値は、答えても使わないので断る（§5.3）。
      const declared = [...state.extractions.values()]
        .flatMap((e) => e.unknowns)
        .find((u) => u.id === command.unknownId);
      const asked = plan.questions.some((q) => q.unknownId === command.unknownId);
      // 家にあるかの値（買い物の手配。仕組みが作る値）は、家に無いと答えた後も、手配が生きている間は、
      // ほかの手で用意できたと答えられる。
      const purchase = plan.arrangements.find(
        (a) => a.kind === 'purchase' && a.atHomeUnknownId === command.unknownId,
      );
      if (!declared && !asked && !purchase?.live) {
        return { status: 'conflict', reason: 'unknownGone' };
      }
      if (retiredUnknowns(state).has(command.unknownId)) {
        return { status: 'conflict', reason: 'unknownRetired' };
      }
      if (declared && !declared.values.includes(command.value)) {
        return { status: 'invalid', reason: 'undeclaredValue' };
      }
      // 仕組みが作る値（家にあるか）は「ある・ない」だけ。
      if (!declared && command.value !== 'yes' && command.value !== 'no') {
        return { status: 'invalid', reason: 'undeclaredValue' };
      }
      if (purchase) {
        // 家にあるかの新しい答えには、札で見せた品物を必ず付け、今の品物と同じ時だけ受ける（問いの札でも。
        // 品物を付けない古い画面からの答えは、直された後の別の品物に答えてしまうので受けない）。
        const what = plan.requirements.find((r) => r.key === purchase.requirementKey)?.what;
        if (command.seen === undefined) return { status: 'invalid', reason: 'seenRequired' };
        if (command.seen.what !== what) return { status: 'conflict', reason: 'proposalChanged' };
      }
      return {
        bodies: [
          {
            type: 'answered',
            unknownId: command.unknownId,
            value: command.value,
            ...(purchase && command.seen ? { about: command.seen.what } : {}),
          },
        ],
      };
    }
    case 'chooseOption': {
      const arrangement = plan.arrangements.find((a) => a.key === command.arrangementKey);
      const option = arrangement?.options.find((o) => o.key === command.optionKey);
      if (!arrangement || !option) return { status: 'conflict', reason: 'optionGone' };
      // 新しく決める命令（選ぶ・担当を提案する・引き受ける）は、今も要る手配・作業にだけ。
      // 既に起きた事の記録（済んだ・送った・返事）は、要らなくなった後でも受け付ける。
      if (!arrangement.live) return { status: 'conflict', reason: 'arrangementGone' };
      // 決め時を過ぎた案は、もう選べない。既に動き出した案（依頼を出した・済んだ作業がある）は、
      // 本命と予備の入れ替えのために選び直してよい。
      const started =
        [...state.requests.values()].some((r) => option.taskKeys.includes(r.taskKey)) ||
        option.taskKeys.some((k) => state.commitments.get(k) === 'done');
      if (option.expired && !started) return { status: 'conflict', reason: 'optionExpired' };
      // 一つの案は、本命か予備のどちらか（予備を本命にするのはよい。本命を予備にはしない）。
      if (command.role === 'backup' && arrangement.chosenOptionKey === option.key) {
        return { status: 'conflict', reason: 'alreadyPrimary' };
      }
      // 既に同じ役で選んでいれば、選び直しの事象は足さない（別の操作として送り直されても、
      // 後の人の引き受けを戻さない）。
      const already =
        command.role === 'primary'
          ? arrangement.chosenOptionKey === option.key
          : arrangement.backupOptionKeys.includes(option.key);
      const chosen: EventBody[] = already
        ? []
        : [
            {
              type: 'optionChosen',
              arrangementKey: arrangement.key,
              optionKey: option.key,
              role: command.role,
            },
          ];
      if (command.assigneeId === undefined) {
        return command.shown === undefined
          ? { bodies: chosen }
          : { status: 'invalid', reason: 'shownWithoutAssignee' };
      }
      const assignee = adultOf(state, command.assigneeId);
      if (!assignee) return { status: 'invalid', reason: 'assigneeNotAnAdult' };
      const steps = option.taskKeys
        .map((key) => taskOf(key))
        .filter((t): t is NonNullable<typeof t> => t !== undefined && !t.extra);
      // 本人しかできない手順（自分の有休の申請など）は、その本人に頼む（選んだ人に付け替えない）。
      const assigneeOf = new Map(steps.map((t) => [t.key, fixedAssigneeOf(state, t) ?? assignee]));
      for (const who of assigneeOf.values()) {
        if (!adultOf(state, who)) return { status: 'invalid', reason: 'assigneeNotAnAdult' };
      }
      // 同じ人が担当で、提案中・引き受け済み・済みの作業は、提案し直さない（引き受けを提案に戻さない）。
      // 断った・できなくなった作業は、もう一度頼む意味があるので提案する。
      const active = new Set(['proposed', 'accepted', 'done']);
      const bodies: EventBody[] = [
        ...chosen,
        ...steps
          .filter(
            (t) =>
              state.assignees.get(t.key) !== assigneeOf.get(t.key) ||
              !active.has(state.commitments.get(t.key) ?? ''),
          )
          .map((t) => ({
            type: 'assignmentProposed' as const,
            taskKey: t.key,
            assigneeId: assigneeOf.get(t.key) ?? assignee,
          })),
      ];
      // 自分が担当なら、本人が画面で見た提案の控え（作業ごと）が今の提案と同じ作業だけを引き受ける。
      // 控えを付けない作業は提案のまま残す。控えが今の提案と違えば、何も足さずに見せ直す（§5.5）。
      const shown = command.shown ?? [];
      for (const entry of shown) {
        const step = steps.find((t) => t.key === entry.taskKey);
        if (!step) return { status: 'invalid', reason: 'shownForUnknownTask' };
        if (assigneeOf.get(step.key) !== me)
          return { status: 'invalid', reason: 'shownForAnother' };
        const current = proposalSnapshot(step);
        if (!current || !sameProposal(current, entry.snapshot)) {
          return { status: 'conflict', reason: 'proposalChanged' };
        }
        bodies.push({
          type: 'commitmentChanged',
          taskKey: step.key,
          assigneeId: me,
          action: 'accept',
          shown: entry.snapshot,
        });
      }
      return { bodies };
    }
    case 'dropOption': {
      // 取り下げられるのは、今選んでいる案（本命か予備）だけ。
      const arrangement = plan.arrangements.find((a) => a.key === command.arrangementKey);
      const chosen =
        arrangement?.chosenOptionKey === command.optionKey ||
        arrangement?.backupOptionKeys.includes(command.optionKey);
      if (!chosen) return { status: 'conflict', reason: 'notChosen' };
      // 見せた後に、その案の作業の担当や状態が替わっていたら（もう一人が持った等）、やめずに見せ直す。
      if (command.seen) {
        const ofOption = (basis: { arrangementKey?: string; optionKey?: string }) =>
          basis.arrangementKey === command.arrangementKey && basis.optionKey === command.optionKey;
        const tasks = plan.tasks.filter((t) => t.live && ofOption(t.basis));
        const requests = plan.requests.filter((r) => r.live && ofOption(r.basis));
        const { tasks: seenTasks, requests: seenRequests } = command.seen;
        const same =
          tasks.length === seenTasks.length &&
          tasks.every((t) => seenTasks.some((s) => s.taskKey === t.key && seenAs(t, s))) &&
          requests.length === seenRequests.length &&
          requests.every((r) =>
            seenRequests.some((s) => s.requestId === r.requestId && s.state === r.state),
          );
        if (!same) return { status: 'conflict', reason: 'optionChanged' };
      }
      return {
        bodies: [{ type: 'optionDropped', ...pick(command, ['arrangementKey', 'optionKey']) }],
      };
    }
    case 'proposeAssignment': {
      const task = taskOf(command.taskKey);
      if (!task?.live) return { status: 'conflict', reason: 'taskGone' };
      // 見せた後に担当や状態が替わっていたら（もう一人が先に持った・引き受けた）、黙って替えない。
      if (command.seen && !seenAs(task, command.seen)) {
        return { status: 'conflict', reason: 'taskChanged' };
      }
      if (!adultOf(state, command.assigneeId)) {
        return { status: 'invalid', reason: 'assigneeNotAnAdult' };
      }
      // 本人しかできない手順は、別の大人に頼めない（決まりを替えるなら、家族の情報を替える）。
      const fixed = fixedAssigneeOf(state, task);
      if (fixed !== undefined && fixed !== command.assigneeId) {
        return { status: 'invalid', reason: 'fixedAssignee' };
      }
      return {
        bodies: [
          { type: 'assignmentProposed', taskKey: command.taskKey, assigneeId: command.assigneeId },
        ],
      };
    }
    case 'accept': {
      // 引き受けは担当の本人だけ。本人が見た提案が今の提案と同じ時だけ（§5.5・§7.3 の 6）。
      const task = taskOf(command.taskKey);
      if (!task?.live) return { status: 'conflict', reason: 'taskGone' };
      if (task.assigneeId !== me) return { status: 'forbidden', reason: 'notTheAssignee' };
      const now = proposalSnapshot(task);
      if (!now || !sameProposal(now, command.shown)) {
        return { status: 'conflict', reason: 'proposalChanged' };
      }
      return {
        bodies: [
          {
            type: 'commitmentChanged',
            taskKey: task.key,
            assigneeId: me,
            action: 'accept',
            shown: command.shown,
          },
        ],
      };
    }
    case 'commitment': {
      const task = taskOf(command.taskKey);
      if (!task) return { status: 'conflict', reason: 'taskGone' };
      if (task.assigneeId !== me) return { status: 'forbidden', reason: 'notTheAssignee' };
      return {
        bodies: [
          { type: 'commitmentChanged', taskKey: task.key, assigneeId: me, action: command.action },
        ],
      };
    }
    case 'recordSent': {
      // 送ったと記録するのは担当の本人だけ。控えは、今の事象からサーバーが作る（§5.6）。
      const task = taskOf(command.taskKey);
      if (!task?.external) return { status: 'conflict', reason: 'taskGone' };
      if (task.assigneeId !== me) return { status: 'forbidden', reason: 'notTheAssignee' };
      // 依頼の ID は、押し間違いを直して消した物も含めて、二度使わない。同じ作業の依頼は一通だけ。
      if (state.sentRequestIds.has(command.requestId)) {
        return { status: 'invalid', reason: 'requestIdTaken' };
      }
      if ([...state.requests.values()].some((r) => r.taskKey === task.key)) {
        return { status: 'conflict', reason: 'alreadySent' };
      }
      return {
        bodies: [
          {
            type: 'externalRequestSent',
            taskKey: task.key,
            requestId: command.requestId,
            snapshot: requestSnapshot(events, context.now, task.key),
          },
        ],
      };
    }
    case 'correctSentRecord': {
      const request = requestOf(command.requestId);
      if (!request) return { status: 'conflict', reason: 'requestGone' };
      if (request.sentBy !== me) return { status: 'forbidden', reason: 'notTheSender' };
      if (request.state !== 'awaitingReply')
        return { status: 'conflict', reason: 'alreadyAnswered' };
      return { bodies: [{ type: 'requestRecordCorrected', requestId: request.requestId }] };
    }
    case 'recordReply':
    case 'recordCancellationSent': {
      const request = requestOf(command.requestId);
      if (!request) return { status: 'conflict', reason: 'requestGone' };
      return {
        bodies: [
          command.type === 'recordReply'
            ? { type: 'externalReplyRecorded', requestId: request.requestId, reply: command.reply }
            : { type: 'cancellationSent', requestId: request.requestId },
        ],
      };
    }
    case 'confirmItem':
    case 'correctItem':
    case 'dismissItem': {
      // 確かめられるのは、今の読み取りにあり、取り下げていない出典の事項だけ。
      const item = itemsOf(state).find((i) => i.id === command.itemId);
      if (!item) return { status: 'conflict', reason: 'itemGone' };
      if (state.withdrawnSources.has(item.sourceId)) {
        return { status: 'conflict', reason: 'sourceWithdrawn' };
      }
      if (command.type === 'confirmItem') {
        return { bodies: [{ type: 'itemConfirmed', itemId: item.id }] };
      }
      if (command.type === 'dismissItem') {
        return { bodies: [{ type: 'itemDismissed', itemId: item.id, reason: command.reason }] };
      }
      if (Object.keys(command.interpretation).length === 0) {
        return { status: 'invalid', reason: 'nothingToCorrect' };
      }
      return {
        bodies: [
          { type: 'itemCorrected', itemId: item.id, interpretation: command.interpretation },
        ],
      };
    }
    case 'withdrawSource':
      if (!state.sources.has(command.sourceId)) return { status: 'conflict', reason: 'sourceGone' };
      // 取り下げ済みなら何も足さない（操作は記録する）。
      if (state.withdrawnSources.has(command.sourceId)) return { bodies: [] };
      return { bodies: [{ type: 'sourceWithdrawn', sourceId: command.sourceId }] };
    case 'advanceClock': {
      if (!context.demo) return { status: 'forbidden', reason: 'demoOnly' };
      // 時計は進めるだけ（戻すと、記録の時刻が前後する）。
      const delta = toEpochMinutes(command.to) - toEpochMinutes(context.now);
      if (delta < 0) return { status: 'invalid', reason: 'clockBackwards' };
      if (delta === 0) return { bodies: [] };
      return { bodies: [{ type: 'clockAdvanced', to: command.to }] };
    }
  }
}

/** 担当にできるのは、今有効な大人だけ。 */
/** 家庭の決まりで、その手順をする本人が決まっていれば、その人（自分の有休の申請など）。 */
function fixedAssigneeOf(
  state: EngineState,
  task: { step?: { templateId: string; stepId: string } | undefined },
): string | undefined {
  if (!task.step) return undefined;
  const { templateId, stepId } = task.step;
  return state.household?.careOptions
    .find((o) => o.id === templateId)
    ?.steps.find((s) => s.id === stepId)?.assigneeId;
}

/** 作業が、画面が見せた担当と状態のままか。 */
function seenAs(
  task: { assigneeId?: string | undefined; commitment: string },
  seen: { assigneeId: string | null; commitment: string },
): boolean {
  return (task.assigneeId ?? null) === seen.assigneeId && task.commitment === seen.commitment;
}

function adultOf(state: EngineState, memberId: string): string | undefined {
  return state.household?.members.find((m) => m.id === memberId && m.kind === 'adult' && m.active)
    ?.id;
}

function pick<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((k) => [k, value[k]])) as Pick<T, K>;
}
