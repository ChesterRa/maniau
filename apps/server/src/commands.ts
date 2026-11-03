// 命令（02-foundation §7.2・§7.3）。画面は事象を直接書かず、命令を送る。サーバーが、権限と前提を
// 確かめて事象に展開する。一つの命令は、家庭を押さえた一続きの中で処理する。
import {
  atHomeAnswerable,
  type Command,
  type DateTime,
  DomainEvent,
  formatDateTime,
  isActiveTask,
  type PlanResult,
  proposalSnapshot,
  sameContent,
  sameProposal,
  toEpochMinutes,
} from '@maniau/core';
import {
  type EngineState,
  foldEvents,
  itemsOf,
  liveItems,
  optionStarted,
  planFromState,
  requestSnapshot,
  retiredUnknowns,
} from '@maniau/core/engine';
import { consequencesOf, violationsOf } from './consequences';
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
  // 「選んだら」で見せた物と、同じ命令の今の「選んだら」（同じ関数で作る）が違えば、断って見せ直す。
  // 見せた時の命令（引き受けの控えを除く）で作り直して比べる。
  if (command.type === 'chooseOption' && command.seen !== undefined) {
    const { seen, shown: _shown, ...asked } = command;
    const form = expand({ plan, state, events }, at, asked);
    const added =
      'reason' in form
        ? []
        : asEvents(
            events,
            withReopened({ plan, events }, form.bodies, context.memberId, now),
            context.memberId,
            now,
          );
    const again =
      'reason' in form
        ? undefined
        : consequencesOf(
            household,
            events,
            new Set(violationsOf(household, events, plan)),
            { before: plan, added, after: planFromState(foldEvents([...events, ...added]), now) },
            {
              arrangementKey: command.arrangementKey,
              optionKey: command.optionKey,
              ...(command.assigneeId === undefined ? {} : { assigneeId: command.assigneeId }),
            },
          );
    if (again?.seen !== seen) {
      return { status: 'conflict', reason: 'consequencesChanged', throughSeq: throughSeq() };
    }
  }
  // 「もう要りません」と出ていた引き受けが、この操作で戻ったら、本人にもう一度頼む（reopened）。
  const bodies = withReopened({ plan, events }, decided.bodies, context.memberId, now);
  if (bodies.length > 0) log.append(bodies, context.memberId, now);
  // 何も起きなかった操作も残す（同じ操作の送り直しで、後の別の人の変更を戻さないため。§7.3 の 7）。
  log.recordOperation({
    id: context.operationId,
    actorId: context.memberId,
    digest,
    throughSeq: throughSeq(),
  });
  return { status: bodies.length > 0 ? 'ok' : 'noop', throughSeq: throughSeq() };
}

/**
 * 「もう要りません」「まだ要るか確かめて」と出ていた引き受け（前の計画の released）が、事象を足して戻ったら
 * （取り消しの取り下げ、答え直し、選び直し、関係ないの取り消し等）、前の引き受けをそのまま当てず、本人に
 * もう一度頼む（§4.2。本人は札や知らせを見て、予定を変えたかもしれない。見なかったとは確かめられない）。
 */
export function reopened(before: PlanResult, after: PlanResult): EventBody[] {
  return (before.released ?? []).flatMap((r): EventBody[] => {
    const task = after.tasks.find((t) => t.key === r.taskKey);
    if (
      !task?.live ||
      !isActiveTask(after, task) ||
      task.commitment !== 'accepted' ||
      task.assigneeId !== r.assigneeId
    ) {
      return [];
    }
    return [{ type: 'assignmentProposed', taskKey: r.taskKey, assigneeId: r.assigneeId }];
  });
}

/**
 * 命令の事象に、それで戻った「もう要りません」の引き受けを頼み直す事象（reopened）を足す。書く時・選ぶ前の
 * 「選んだら」・見せた物の作り直しで、同じ展開を使う（どれかだけが頼み直しを含むと、見せた計画と書いた後の
 * 計画が違ってしまう）。
 */
function withReopened(
  { plan, events }: Pick<Now, 'plan' | 'events'>,
  bodies: EventBody[],
  memberId: string,
  now: DateTime,
): EventBody[] {
  if (bodies.length === 0 || (plan.released?.length ?? 0) === 0) return bodies;
  const after = planFromState(
    foldEvents([...events, ...asEvents(events, bodies, memberId, now)]),
    now,
  );
  return [...bodies, ...reopened(plan, after)];
}

/**
 * 命令を書き込まずに展開し、展開した事象を足した後の計画を返す（選ぶ前に、選んだら何が起きるかを見せる。
 * 書く時と同じ確かめと同じ計算）。足すはずの事象（added）も返す（検証器は事象から選択を読むので、後の計画を
 * 確かめる時は、これを足した事象の列で確かめる）。操作 ID は引かない（何も残さない）。
 */
export function previewCommand(
  events: readonly DomainEvent[],
  context: Pick<CommandContext, 'memberId' | 'now'>,
  command: Command,
  /** 同じ事象の列から作った状態と今の計画（いくつも見る時に、作り直さない）。 */
  base?: { state: EngineState; plan: PlanResult },
):
  | { status: 'ok'; before: PlanResult; after: PlanResult; added: DomainEvent[] }
  | { status: 'conflict' | 'forbidden' | 'invalid'; reason: string } {
  const state = base?.state ?? foldEvents(events);
  const household = state.household;
  const member = household?.members.find((m) => m.id === context.memberId);
  if (!household || !member || member.kind !== 'adult' || !member.active) {
    return { status: 'forbidden', reason: 'notAnActiveAdult' };
  }
  const now =
    state.clock === undefined ? context.now : formatDateTime(state.clock, household.timeZone);
  const before = base?.plan ?? planFromState(state, now);
  const decided = expand(
    { plan: before, state, events },
    { memberId: context.memberId, operationId: 'preview', now, demo: false },
    command,
  );
  if ('reason' in decided) return decided;
  const added = asEvents(
    events,
    withReopened({ plan: before, events }, decided.bodies, context.memberId, now),
    context.memberId,
    now,
  );
  return {
    status: 'ok',
    before,
    after: planFromState(foldEvents([...events, ...added]), now),
    added,
  };
}

/** 書き込まない事象（「選んだら」の計算だけに使う。通し番号は今の後に続ける）。 */
function asEvents(
  events: readonly DomainEvent[],
  bodies: readonly EventBody[],
  actorId: string,
  now: DateTime,
): DomainEvent[] {
  let seq = events.at(-1)?.seq ?? 0;
  const householdId = events[0]?.householdId ?? '';
  return bodies.map((body) => {
    seq += 1;
    return DomainEvent.parse({
      id: `preview-${seq}`,
      householdId,
      seq,
      version: 1,
      occurredAt: now,
      recordedAt: now,
      actorId,
      ...body,
    });
  });
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
      // 家にあるかの値（持ち物の要件。仕組みが作る値）は、要件が生きていて、用意の締切の前か書かれた使う日が
      // 終わるまでだけ答えられる（atHomeAnswerable。画面・一言と同じ決まり）。問いが消えた後も答えられる（無いと
      // 答えた後の「用意できた」、あると答えた後の「やっぱり無かった」）。条件が外れて要らない間は、古い札から
      // 答えても受けない（条件が戻った時に、その答えを使ってしまう）。
      const atHome = plan.requirements.find((r) => r.atHomeUnknownId === command.unknownId);
      if (atHome ? !atHomeAnswerable(atHome, plan.now) : !declared && !asked) {
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
      if (atHome) {
        // 家にあるかの新しい答えには、札で見せた品物を必ず付け、今の品物と同じ時だけ受ける（問いの札でも。
        // 品物を付けない古い画面からの答えは、直された後の別の品物に答えてしまうので受けない）。
        if (command.seen === undefined) return { status: 'invalid', reason: 'seenRequired' };
        if (command.seen.what !== atHome.what) {
          return { status: 'conflict', reason: 'proposalChanged' };
        }
        // 見せた後に、この値への答えが入っていれば（もう一人の答え・同じ答えの言い直しでも）、受けない。
        const shownAt = command.seen.throughSeq;
        if (
          events.some(
            (e) => e.type === 'answered' && e.unknownId === command.unknownId && e.seq > shownAt,
          )
        ) {
          return { status: 'conflict', reason: 'proposalChanged' };
        }
      }
      return {
        bodies: [
          {
            type: 'answered',
            unknownId: command.unknownId,
            value: command.value,
            ...(atHome && command.seen ? { about: command.seen.what } : {}),
          },
        ],
      };
    }
    case 'chooseOption': {
      const arrangement = plan.arrangements.find((a) => a.key === command.arrangementKey);
      const option = arrangement?.options.find((o) => o.key === command.optionKey);
      const household = state.household;
      if (!arrangement || !option || !household)
        return { status: 'conflict', reason: 'optionGone' };
      // 新しく決める命令（選ぶ・担当を提案する・引き受ける）は、今も要る手配・作業にだけ。
      // 既に起きた事の記録（済んだ・送った・返事）は、要らなくなった後でも受け付ける。
      if (!arrangement.live) return { status: 'conflict', reason: 'arrangementGone' };
      // 決め時を過ぎた案は、もう選べない。既に動き出した案（今の日の分の依頼を出した・今の用件に
      // 当たる済んだ手順がある）は、本命と予備の入れ替えのために選び直してよい（エンジンと同じ判断）。
      const started = optionStarted(state, arrangement, option, plan.tasks, household.timeZone);
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
      // 根拠の事項とお知らせを控える（後で作業が無くなった時に、はっきり要らなくなったのか、根拠を消した・
      // 読み直しで見つからない等で分からないのかを分ける）。
      const sourceOf = new Map(itemsOf(state).map((i) => [i.id, i.sourceId]));
      const basisItemIds = [...new Set(task.basis.itemIds)].sort();
      const basisSourceIds = [
        ...new Set(basisItemIds.flatMap((id) => sourceOf.get(id) ?? [])),
      ].sort();
      return {
        bodies: [
          {
            type: 'commitmentChanged',
            taskKey: task.key,
            assigneeId: me,
            action: 'accept',
            shown: command.shown,
            basisItemIds,
            basisSourceIds,
          },
        ],
      };
    }
    case 'commitment': {
      const task = taskOf(command.taskKey);
      if (!task) return { status: 'conflict', reason: 'taskGone' };
      if (task.assigneeId !== me) return { status: 'forbidden', reason: 'notTheAssignee' };
      if (command.action !== 'done') {
        return {
          bodies: [
            {
              type: 'commitmentChanged',
              taskKey: task.key,
              assigneeId: me,
              action: command.action,
            },
          ],
        };
      }
      // 済んだのは、札で見せた用件。今の用件と違えば（直されて別の物になった後の古い札）、断って
      // 見せ直す。記録には見せた用件を残し、後で用件が替わっても、前の物の済みを当てない。
      if (command.seen === undefined) return { status: 'invalid', reason: 'seenRequired' };
      const content = { titleKey: task.titleKey, titleParams: task.titleParams };
      if (!sameContent(command.seen, content))
        return { status: 'conflict', reason: 'proposalChanged' };
      return {
        bodies: [
          {
            type: 'commitmentChanged',
            taskKey: task.key,
            assigneeId: me,
            action: 'done',
            content: command.seen,
          },
        ],
      };
    }
    case 'recordSent': {
      // 送ったと記録するのは担当の本人だけ。控えは、今の事象からサーバーが作る（§5.6）。
      const task = taskOf(command.taskKey);
      if (!task?.external) return { status: 'conflict', reason: 'taskGone' };
      if (task.assigneeId !== me) return { status: 'forbidden', reason: 'notTheAssignee' };
      // 依頼の ID は、押し間違いを直して消した物も含めて、二度使わない。
      if (state.sentRequestIds.has(command.requestId)) {
        return { status: 'invalid', reason: 'requestIdTaken' };
      }
      const snapshot = requestSnapshot(events, context.now, task.key);
      // 頼む時間のある依頼（子の居場所）は、画面で見せた頼む時間が今の控えと同じ時だけ受ける（見せた後に日や
      // 時間が直されていたら、記録せず見せ直す。古い画面の「送った」で、新しい日を送ったことにしない）。
      if (snapshot.window) {
        if (!command.window) return { status: 'invalid', reason: 'windowRequired' };
        if (
          toEpochMinutes(command.window.start) !== toEpochMinutes(snapshot.window.start) ||
          toEpochMinutes(command.window.end) !== toEpochMinutes(snapshot.window.end)
        ) {
          return { status: 'conflict', reason: 'proposalChanged' };
        }
      }
      // 同じ作業の依頼は、同じ日の分につき一通（日が直されたら、新しい日の分を頼み直せる）。時間で頼まない
      // 依頼は一通だけ。控えの時刻は家庭の時区で書いてある（日をそのまま読める）。取り消しを伝えた依頼は
      // 数えない（日が戻ったり、案を選び直したりしたら、同じ日の分を頼み直せる）。
      const day = (window: { start: DateTime } | undefined) => window?.start.slice(0, 10);
      if (
        [...state.requests.values()].some(
          (r) =>
            r.taskKey === task.key &&
            r.state !== 'cancelled' &&
            day(r.snapshot?.window) === day(snapshot.window),
        )
      ) {
        return { status: 'conflict', reason: 'alreadySent' };
      }
      return {
        bodies: [
          {
            type: 'externalRequestSent',
            taskKey: task.key,
            requestId: command.requestId,
            snapshot,
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
    case 'stateTurn': {
      // うちの番かを言えるのは、今の読み取りにあり、取り下げていない出典の、家の人の当番だけ。
      const item = itemsOf(state).find((i) => i.id === command.itemId);
      if (!item) return { status: 'conflict', reason: 'itemGone' };
      if (state.withdrawnSources.has(item.sourceId)) {
        return { status: 'conflict', reason: 'sourceWithdrawn' };
      }
      if (item.kind !== 'duty' || item.interpretation.familyAction !== true) {
        return { status: 'invalid', reason: 'notADuty' };
      }
      // 見せた後に、その出典の文・事項・答え・言明が替わっていれば（もう一人が直した・言った。替わって元に
      // 戻った時も）、古い画面から決めさせない。
      if ((state.sourceChangedSeq.get(item.sourceId) ?? 0) > command.seen.throughSeq) {
        return { status: 'conflict', reason: 'itemChanged' };
      }
      // 「うちの番ではない」で無くなる作業を、ほかの大人が持っていれば断る（本人の引き受けは取り下げる）。
      const released = command.ours
        ? []
        : releaseFor(
            plan.tasks.find(
              (t) => t.live && t.titleKey === 'task.duty' && t.basis.itemIds.includes(item.id),
            ),
            me,
          );
      if (!Array.isArray(released)) return released;
      // 言った時の用件と対象を控える（後で直されたら、もう当てない）。事項の確かさと作用は変えない。
      return {
        bodies: [
          ...released,
          {
            type: 'turnStated',
            itemId: item.id,
            ours: command.ours,
            what: item.interpretation.what ?? item.written,
            audience: item.interpretation.audience ?? null,
          },
        ],
      };
    }
    case 'acknowledgeReleased': {
      // 見せた計画と今の計画が同じで、その札が今も本人の「要らなくなった引き受け」の時だけ、引き受けを取り
      // 下げる（見せた後に作業が戻った・また無くなった時に、古い札で今の引き受けを取り下げない）。
      if (plan.throughSeq !== command.seen.throughSeq) {
        return { status: 'conflict', reason: 'itemChanged' };
      }
      const released = plan.released?.find(
        (r) => r.taskKey === command.taskKey && r.assigneeId === me,
      );
      if (!released) return { status: 'conflict', reason: 'releasedGone' };
      return {
        bodies: [
          {
            type: 'commitmentChanged',
            taskKey: released.taskKey,
            assigneeId: me,
            action: 'withdraw',
          },
        ],
      };
    }
    case 'stateEscort': {
      const entry = liveItems(state).find((l) => l.item.id === command.itemId);
      if (!entry) return { status: 'conflict', reason: 'itemGone' };
      if (state.withdrawnSources.has(entry.item.sourceId)) {
        return { status: 'conflict', reason: 'sourceWithdrawn' };
      }
      // 見せた計画と今の計画の通し番号が同じ時だけ受ける（後に家庭の記録に何か入った古い画面も、今より先の
      // 番号を付けた誤った画面も断る）。送り迎えの要否は、行事の効き方（ほかの出典の取り消しと、その取り
      // 下げで元に戻った時も）と家の決まりの両方で変わるので、出典ごとの番号でなく、計画全体の番号で比べる。
      if (plan.throughSeq !== command.seen.throughSeq) {
        return { status: 'conflict', reason: 'itemChanged' };
      }
      // 言えるのは、今の計画で生きている、確かな習い事・クラブの行事の送り迎えだけ（送り迎えの子が決まる時。
      // escortFrameOf）。
      if (!entry.live || !entry.trusted) return { status: 'conflict', reason: 'itemNotLive' };
      const frame = entry.escort;
      const leg = frame?.legs.find((l) => l.leg === command.leg);
      if (!frame || !leg) return { status: 'invalid', reason: 'notAnEscort' };
      // 同じことを言い直しても、何も足さない。
      if (leg.stated && leg.needed === command.needed) return { bodies: [] };
      // 「今回は要らない」で無くなる作業を、ほかの大人が持っていれば断る（本人の引き受けは取り下げる）。
      const titleKey = command.leg === 'to' ? 'task.escortTo' : 'task.escortFrom';
      const released = command.needed
        ? []
        : releaseFor(
            plan.tasks.find(
              (t) => t.live && t.titleKey === titleKey && t.basis.itemIds.includes(entry.item.id),
            ),
            me,
          );
      if (!Array.isArray(released)) return released;
      // 言った時の子・用件・日・書かれた時刻・場所を控える（どれかが変われば、もう当てない）。事項の確かさと
      // 作用は変えない。
      return {
        bodies: [
          ...released,
          {
            type: 'escortStated',
            itemId: entry.item.id,
            leg: command.leg,
            needed: command.needed,
            childId: frame.childId,
            what: entry.item.interpretation.what ?? entry.item.written,
            date: leg.date,
            at: leg.at ?? null,
            place: entry.item.interpretation.place ?? null,
          },
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

/**
 * 家族の言明（うちの番ではない・今回は要らない）で作業が無くなる時：ほかの大人が引き受けた・済ませた作業は、
 * 黙って消さない（断る。持った人が言うか、持った人と話してもらう）。言った本人が引き受けていた作業は、引き
 * 受けを取り下げる（言い直して作業が戻った時に、前の引き受けを当てない）。まだ引き受けていない提案と、担当の
 * 無い作業は、そのまま無くなる。
 */
function releaseFor(
  task: PlanResult['tasks'][number] | undefined,
  me: string,
): EventBody[] | { status: 'conflict'; reason: string } {
  if (task?.assigneeId === undefined) return [];
  const held = task.commitment === 'accepted' || task.commitment === 'done';
  if (task.assigneeId !== me) return held ? { status: 'conflict', reason: 'heldByOther' } : [];
  return task.commitment === 'accepted'
    ? [{ type: 'commitmentChanged', taskKey: task.key, assigneeId: me, action: 'withdraw' }]
    : [];
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
