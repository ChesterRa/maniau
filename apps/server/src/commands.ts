// 命令（02-foundation §7.2・§7.3）。画面は事象を直接書かず、命令を送る。サーバーが、権限と前提を
// 確かめて事象に展開する。一つの命令は、家庭を押さえた一続きの中で処理する。

import { createHash, randomBytes } from 'node:crypto';
import {
  AFTER_SCHOOL_MAX_DAYS,
  AFTER_SCHOOL_WEEKDAYS,
  type AfterSchoolDeadline,
  afterSchoolOption,
  applyCorrection,
  atHomeAnswerable,
  type CareOptionTemplate,
  type Command,
  careDays,
  type DateTime,
  DomainEvent,
  formatDateTime,
  HELPER_ASK_DAYS,
  type Household,
  helperAskOption,
  type Interpretation,
  isActiveTask,
  isNeedArrangementKey,
  LEAVE_MAX_BUSINESS_DAYS,
  leaveOption,
  localDateOf,
  type MapInputs,
  type NeedInterpretation,
  type PlaceKind,
  type PlanResult,
  proposalSnapshot,
  repeatedNames,
  SELF_WAY_ID,
  type SurveyCandidate,
  sameContent,
  sameNamePairs,
  sameProposal,
  shownName,
  stoppedWay,
  surveyPreparation,
  taskContent,
  toEpochMinutes,
  validateHousehold,
  type Way,
  zonedToEpochMinutes,
} from '@maniau/core';
import {
  awaitingConfirmation,
  currentReadings,
  dateConditionLinks,
  decisionBasis,
  type EngineState,
  familyQuestionBasis,
  foldEvents,
  itemShown,
  itemsOf,
  keys,
  liveItems,
  needArrangementInUse,
  needWaysBasis,
  optionStarted,
  planFromState,
  requestSnapshot,
  retiredUnknowns,
} from '@maniau/core/engine';
import { consequencesOf, householdConsequences, violationsOf } from './consequences';
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
  /** この要求のために地図から引いた根拠（同じ要求の計算・確かめ・画面が同じ物を使う）。 */
  maps?: MapInputs;
  /**
   * このデモで調べて見せた周りの資源の候補（02-foundation §3.5）。家の情報に新しく入れられる資源と前提は、ここに
   * ある物と同じ中身の物だけ（家族が選ぶ扱い・状態を除く）。
   */
  surveyed?: readonly SurveyCandidate[];
}

export type CommandResult =
  | {
      status: 'ok' | 'noop';
      throughSeq: number;
      /** 答えるリンクを出した時だけ、その鍵（応答で一度だけ。送り直しの noop には付けない）。 */
      answerLink?: { personId: string; token: string };
    }
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
  const plan = planFromState(state, now, context.maps);
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
            withReopened({ plan, events }, form.bodies, context.memberId, now, context.maps),
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
            {
              before: plan,
              added,
              after: planFromState(foldEvents([...events, ...added]), now, context.maps),
            },
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
  // 家の情報の直し・「すること」の言明・やり方の選び・計画に入っている「すること」の直しと外しは、見せた計画の
  // 番号と、見せた「この変更で変わること」（送られた中身を含む要約）が、押さえた中で今の時刻に作り直した物と
  // 同じ時だけ書く（もう一人の直し・時が進んで変わった結果を、黙って書かない）。
  const previewed = previewedInput(command, state);
  if (previewed) {
    if (previewed.seen === undefined) {
      return { status: 'invalid', reason: 'seenRequired', throughSeq: throughSeq() };
    }
    if (previewed.seen.throughSeq !== plan.throughSeq) {
      return { status: 'conflict', reason: 'proposalChanged', throughSeq: throughSeq() };
    }
    const added = asEvents(
      events,
      withReopened({ plan, events }, decided.bodies, context.memberId, now, context.maps),
      context.memberId,
      now,
    );
    const set = added.find((e) => e.type === 'householdSet');
    const again = householdConsequences(
      { household, events, plan },
      {
        household: set?.type === 'householdSet' ? set.household : household,
        added,
        plan: planFromState(foldEvents([...events, ...added]), now, context.maps),
      },
      previewed.input,
    );
    if (again.seen !== previewed.seen.changes) {
      return { status: 'conflict', reason: 'consequencesChanged', throughSeq: throughSeq() };
    }
  }
  // 「もう要りません」と出ていた引き受けが、この操作で戻ったら、本人にもう一度頼む（reopened）。
  const bodies = withReopened(
    { plan, events },
    decided.bodies,
    context.memberId,
    now,
    context.maps,
  );
  if (bodies.length > 0) log.append(bodies, context.memberId, now);
  // 何も起きなかった操作も残す（同じ操作の送り直しで、後の別の人の変更を戻さないため。§7.3 の 7）。
  log.recordOperation({
    id: context.operationId,
    actorId: context.memberId,
    digest,
    throughSeq: throughSeq(),
  });
  return {
    status: bodies.length > 0 ? 'ok' : 'noop',
    throughSeq: throughSeq(),
    ...('answerLink' in decided && decided.answerLink && bodies.length > 0
      ? { answerLink: decided.answerLink }
      : {}),
  };
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
  maps: MapInputs | undefined,
): EventBody[] {
  if (bodies.length === 0 || (plan.released?.length ?? 0) === 0) return bodies;
  const after = planFromState(
    foldEvents([...events, ...asEvents(events, bodies, memberId, now)]),
    now,
    maps,
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
  context: Pick<CommandContext, 'memberId' | 'now' | 'maps' | 'surveyed'>,
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
  const before = base?.plan ?? planFromState(state, now, context.maps);
  const decided = expand(
    { plan: before, state, events },
    {
      memberId: context.memberId,
      operationId: 'preview',
      now,
      demo: false,
      ...(context.maps ? { maps: context.maps } : {}),
      ...(context.surveyed ? { surveyed: context.surveyed } : {}),
    },
    command,
  );
  if ('reason' in decided) return decided;
  const added = asEvents(
    events,
    withReopened({ plan: before, events }, decided.bodies, context.memberId, now, context.maps),
    context.memberId,
    now,
  );
  return {
    status: 'ok',
    before,
    after: planFromState(foldEvents([...events, ...added]), now, context.maps),
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
  | { bodies: EventBody[]; answerLink?: { personId: string; token: string } }
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
      // 家族が決める値は、見せた計画の通し番号が今と同じ時だけ受ける（問いの中身・値ごとの要る物・もう一人の
      // 答え・読み直しが、見せた後に替わっていれば断って見せ直す。前に戻った時も、先の番号も）。
      if (declared?.kind === 'family') {
        if (command.seen === undefined) return { status: 'invalid', reason: 'seenRequired' };
        // 文を直して、読み直す前は答えない（問いの名前が今の文と合っているか分からない。問いも出さない）。
        if (!currentReadings(state).some((e) => e.unknowns.some((u) => u.id === declared.id))) {
          return { status: 'conflict', reason: 'rereadPending' };
        }
        if (command.seen.throughSeq !== plan.throughSeq) {
          return { status: 'conflict', reason: 'proposalChanged' };
        }
        // 問いの札からの答えは、今の時刻で作った問いが、見せた物と同じ時だけ（期限が過ぎて消えた・変わった問い
        // の古い札を断る。事象が無くても、時が進めば問いは変わる）。
        const shown = command.seen.question;
        if (shown) {
          const current = plan.questions.find(
            (q) => q.key === shown.key && q.unknownId === command.unknownId,
          );
          const sameUntil =
            current?.until === undefined || shown.until === undefined
              ? current?.until === shown.until
              : toEpochMinutes(current.until) === toEpochMinutes(shown.until);
          const sameAffects =
            current !== undefined &&
            JSON.stringify([...current.affects].sort()) ===
              JSON.stringify([...shown.affects].sort());
          if (!current || !sameUntil || !sameAffects) {
            return { status: 'conflict', reason: 'proposalChanged' };
          }
        }
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
            // 家にあるかは見せた品物、家族が決める値は今の問いの形（名前・値・使う事項の中身と条件の式）を控える
            // （読み直しや直しで別の問い・別の日の行事・逆の条件になったら、この答えを当てない）。
            ...(atHome && command.seen
              ? { about: command.seen.what }
              : declared?.kind === 'family'
                ? { about: familyQuestionBasis(state, declared) }
                : {}),
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
      // やめたやり方の案は、新しくは選べない（今、本命か予備に選んである物は、役を替えて選び直せる）。
      if (
        stoppedWay(household, arrangement, option) &&
        arrangement.chosenOptionKey !== option.key &&
        !arrangement.backupOptionKeys.includes(option.key)
      ) {
        return { status: 'invalid', reason: 'wayInactive' };
      }
      // 子の居場所で、手配の時間のうち見てもらえない時間が残る手は、選べない（本命にも予備にも。今と同じ役で送り
      // 直すのはよい）。見てもらえない時間を残したまま頼むと、頼んだ時間と見てもらえる時間が食い違う。
      if (
        arrangement.kind === 'childCare' &&
        option.coverGaps !== undefined &&
        !(command.role === 'primary'
          ? arrangement.chosenOptionKey === option.key
          : arrangement.backupOptionKeys.includes(option.key))
      ) {
        return { status: 'invalid', reason: 'optionNotCovering' };
      }
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
      if (!sameContent(command.seen, taskContent(task)))
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
      // 送ったと記録するのは担当の本人だけ。控えはサーバーが作る（§5.6）。
      let task = taskOf(command.taskKey);
      let snapshot = task?.external ? requestSnapshot(events, context.now, task.key) : undefined;
      const shown = command.shown;
      if (
        shown &&
        (shown.throughSeq > plan.throughSeq ||
          toEpochMinutes(shown.at) > toEpochMinutes(context.now))
      )
        return { status: 'conflict', reason: 'taskGone' };
      if (!snapshot || (shown && shown.throughSeq < plan.throughSeq)) {
        // 外で送った直後に、もう一人が出典を外した・取り下げた・日を直した場合もある。画面の版と時刻から
        // 当時の計画を作り直し、本人に出ていた作業だけを当時の控えで記録する。今の相手や日を推して埋めない。
        if (!shown) return { status: 'conflict', reason: 'taskGone' };
        const before = events.filter((event) => event.seq <= shown.throughSeq);
        const previous = foldEvents(before);
        if (previous.lastSeq !== shown.throughSeq)
          return { status: 'conflict', reason: 'taskGone' };
        const oldPlan = planFromState(previous, shown.at, context.maps);
        const oldTask = oldPlan.tasks.find((entry) => entry.key === command.taskKey);
        if (
          !oldTask?.live ||
          !oldTask.external ||
          oldTask.assigneeId !== me ||
          !isActiveTask(oldPlan, oldTask)
        )
          return { status: 'conflict', reason: 'taskGone' };
        const sources = new Set(
          itemsOf(previous)
            .filter((item) => oldTask.basis.itemIds.includes(item.id))
            .map((item) => item.sourceId),
        );
        const after = events.filter((event) => event.seq > shown.throughSeq);
        const changed = after.some(
          (event) =>
            ((event.type === 'sourceExcluded' || event.type === 'sourceWithdrawn') &&
              sources.has(event.sourceId)) ||
            (event.type === 'itemCorrected' && oldTask.basis.itemIds.includes(event.itemId)),
        );
        const refusedLater = after.some(
          (event) =>
            event.type === 'commitmentChanged' &&
            event.taskKey === command.taskKey &&
            event.actorId === me &&
            (event.action === 'decline' || event.action === 'withdraw'),
        );
        // 削除した中身を、過去の画面から復活させない。
        const purged = [...sources].some((id) => state.purgedSources.get(id) === 'all');
        // 用件の控えが同じでも、本人が後から辞退した・原文が削除された時は、古い画面で送信を記録しない。
        if (refusedLater || purged) return { status: 'conflict', reason: 'taskGone' };
        const oldSnapshot = requestSnapshot(before, shown.at, oldTask.key);
        if (!sameJson(snapshot, oldSnapshot)) {
          if (!changed)
            return { status: 'conflict', reason: snapshot ? 'proposalChanged' : 'taskGone' };
          task = oldTask;
          snapshot = oldSnapshot;
        }
      }
      if (!task?.external || !snapshot) return { status: 'conflict', reason: 'taskGone' };
      if (task.assigneeId !== me) return { status: 'forbidden', reason: 'notTheAssignee' };
      // 依頼の ID は、押し間違いを直して消した物も含めて、二度使わない。
      if (state.sentRequestIds.has(command.requestId)) {
        return { status: 'invalid', reason: 'requestIdTaken' };
      }
      // 頼む時間のある依頼は、画面で見せた頼む時間と控えが同じ時だけ受ける。
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
    case 'resolveRequestCheck': {
      const request = requestOf(command.requestId);
      if (!request) return { status: 'conflict', reason: 'requestGone' };
      if (request.sentBy !== me) return { status: 'forbidden', reason: 'notTheSender' };
      if (command.seen === undefined) return { status: 'invalid', reason: 'seenRequired' };
      if (command.seen.throughSeq !== plan.throughSeq)
        return { status: 'conflict', reason: 'proposalChanged' };
      if (
        !request.live ||
        !['awaitingReply', 'confirmed'].includes(request.state) ||
        (request.needsCheck !== true && !(request.standalone && command.decision === 'cancel'))
      )
        return { status: 'conflict', reason: 'requestChanged' };
      const original = state.requests.get(request.requestId);
      if (!original?.snapshot) return { status: 'invalid', reason: 'legacyRequestUnclear' };
      if (command.decision === 'keep') {
        const snapshot = original.snapshot;
        const household = state.household;
        const window = snapshot.window;
        if (
          snapshot.basis.arrangementKey?.startsWith('arr:childCare:') &&
          (!snapshot.childId || !snapshot.window)
        )
          return { status: 'invalid', reason: 'legacyRequestUnclear' };
        const sameCare =
          household &&
          snapshot.childId &&
          window &&
          plan.arrangements.some(
            (a) =>
              a.live &&
              a.kind === 'childCare' &&
              a.childId === snapshot.childId &&
              localDateOf(toEpochMinutes(a.start), household.timeZone) ===
                localDateOf(toEpochMinutes(window.start), household.timeZone),
          );
        if (
          sameCare ||
          plan.arrangements.some((a) => a.live && a.key === request.basis.arrangementKey)
        )
          return { status: 'conflict', reason: 'arrangementReturned' };
      }
      return {
        bodies: [
          {
            type: 'requestCheckResolved',
            requestId: request.requestId,
            decision: command.decision,
          },
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
      // モデルが読んだ「すること」（家族の言明でない出典の need）は、確かめるまで計画に入らない（エンジン）。確かめる・
      // 直す・外すのは、見せた中身に対してだけ：見せた計画の通し番号が今と同じ時だけ受ける（条件や答える値の名前は、
      // ほかの出典の読み取りから来ることがあり、出典ごとの番号では、その読み直しを見落とす。替わって元に戻った時も、
      // 今より先の番号も断る）。送り手が家族でも、モデルが読んだ物は同じ。
      const noticeNeed = item.kind === 'need' && !state.statedSources.has(item.sourceId);
      if (noticeNeed) {
        if (!command.seen) return { status: 'invalid', reason: 'seenRequired' };
        if (command.seen.throughSeq > state.lastSeq)
          return { status: 'invalid', reason: 'seenAhead' };
        if (command.seen.throughSeq !== state.lastSeq) {
          return { status: 'conflict', reason: 'itemChanged' };
        }
        // 文を直して、読み直す前は決めさせない（見せた読み取りは前の文の物。家族が決める値の答えと同じ）。
        const source = state.sources.get(item.sourceId);
        if (source && (state.extractionVersion.get(item.sourceId) ?? 0) < source.version) {
          return { status: 'conflict', reason: 'rereadPending' };
        }
        // 条件の式や答える値を画面に見せられない読み取りは、確かめ・直しで認めさせない（外すことはできる）。
        if (command.type !== 'dismissItem' && !itemShown(state, item).shown) {
          return { status: 'invalid', reason: 'readingUnshown' };
        }
      }
      if (command.type === 'dismissItem') {
        return { bodies: [{ type: 'itemDismissed', itemId: item.id, reason: command.reason }] };
      }
      if (command.type === 'confirmItem') {
        // 「合っている」は、形のそろった読み取りにだけ（足りない欄を、確かめで埋めたことにしない。直してもらう）。
        if (noticeNeed) {
          const i = item.interpretation;
          if (i.shape === undefined) return { status: 'invalid', reason: 'needShapeMissing' };
          const checked = checkNeed(state.household, {
            ...i,
            what: i.what ?? item.written,
            shape: i.shape,
          });
          if ('reason' in checked) return checked;
        }
        return { bodies: [{ type: 'itemConfirmed', itemId: item.id }] };
      }
      if (Object.keys(command.interpretation).length === 0) {
        return { status: 'invalid', reason: 'nothingToCorrect' };
      }
      if (
        item.kind !== 'need' &&
        command.interpretation.date !== undefined &&
        command.interpretation.date !== item.interpretation.date &&
        dateConditionLinks(state, item).length > 0
      ) {
        return { status: 'invalid', reason: 'dateLinkedCondition' };
      }
      const readingBound = item.kind !== 'need' && !state.statedSources.has(item.sourceId);
      if (readingBound) {
        const source = state.sources.get(item.sourceId);
        if (!source || (state.extractionVersion.get(item.sourceId) ?? 0) < source.version)
          return { status: 'conflict', reason: 'rereadPending' };
      }
      // 家族の言明の「すること」は、直した後も言った時と同じ決まりで確かめる。形（締切か時間か）は替えない
      // （替えるなら言い直す。前の形の欄を残したまま別の形にしない）。読み取りに形が無かった物だけ、形を入れられる。
      // いつにするかの候補のある「すること」：形・日・時刻はいつも直せない（時刻は候補が持つ）。何を・場所・だれのため・
      // 受け持ちが要るかは、使う前だけ直せて、全部の候補の代を進める（答えと決めた事を古い中身に当てない）。
      const candidates = state.needCandidates.get(item.id) ?? [];
      let bumped: EventBody[] = [];
      if (item.kind === 'need' && candidates.length > 0) {
        const locked = ['shape', 'date', 'startTime', 'endTime', 'deadline', 'deadlineDayOnly'];
        if (Object.keys(command.interpretation).some((key) => locked.includes(key))) {
          return { status: 'invalid', reason: 'candidateNeedTimeLocked' };
        }
        if (whenOf(plan, item.id)?.inUse) return { status: 'conflict', reason: 'decisionInUse' };
        bumped = [
          {
            type: 'needCandidatesSet',
            itemId: item.id,
            candidates: candidates.map((c) => ({ ...c, rev: c.rev + 1 })),
          },
        ];
      }
      if (item.kind === 'need') {
        // 直しの null（だれのためを外す）は、外した後の中身で確かめる。
        const merged = applyCorrection(item.interpretation, command.interpretation);
        if (merged.shape === undefined) return { status: 'invalid', reason: 'needShapeMissing' };
        if (item.interpretation.shape !== undefined && merged.shape !== item.interpretation.shape) {
          return { status: 'invalid', reason: 'needShapeLocked' };
        }
        const checked = checkNeed(
          state.household,
          {
            ...merged,
            what: merged.what ?? item.written,
            shape: merged.shape,
          },
          candidates.length > 0,
        );
        if ('reason' in checked) return checked;
      }
      return {
        bodies: [
          {
            type: 'itemCorrected',
            itemId: item.id,
            interpretation: command.interpretation,
            ...(readingBound ? { readingBound: true as const } : {}),
          },
          ...bumped,
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
    case 'discardSource':
      if (!state.sources.has(command.sourceId)) return { status: 'conflict', reason: 'sourceGone' };
      // 家族が自分で言った「すること」はお知らせの読み取りではない（その画面から直す・要らなくする）。
      if (state.statedSources.has(command.sourceId))
        return { status: 'invalid', reason: 'statedSourceNotNotice' };
      if (state.excludedSources.has(command.sourceId)) return { bodies: [] };
      if (state.withdrawnSources.has(command.sourceId))
        return { status: 'conflict', reason: 'sourceWithdrawn' };
      // 前の形で控えの無い依頼は、出典を外すと今の作業から相手と根拠を復元できなくなることがある。
      // 誰に何を送ったか作らず、先に家族が確認できるよう、この操作は受けない。
      if (
        [...state.requests.values()].some(
          (request) =>
            request.snapshot === undefined &&
            (request.state === 'awaitingReply' || request.state === 'confirmed'),
        )
      )
        return { status: 'invalid', reason: 'legacyRequestUnclear' };
      return {
        bodies: [{ type: 'sourceExcluded', sourceId: command.sourceId, reason: command.reason }],
      };
    case 'withdrawSource':
      if (!state.sources.has(command.sourceId)) return { status: 'conflict', reason: 'sourceGone' };
      // 取り下げ済みなら何も足さない（操作は記録する）。
      if (state.withdrawnSources.has(command.sourceId)) return { bodies: [] };
      return { bodies: [{ type: 'sourceWithdrawn', sourceId: command.sourceId }] };
    case 'updateHousehold': {
      const checked = checkHouseholdEdit(
        state.household,
        command.household,
        context.now,
        context.surveyed ?? [],
      );
      if ('reason' in checked) return checked;
      return { bodies: [{ type: 'householdSet', household: checked.household }] };
    }
    case 'stateNeed': {
      // 家族の一言（原文）を家族の出典にし、確かめた欄をその出典の「すること」（言明）にする。出典の ID は、
      // 言った人・中身・見た時の番号から決める（見せた「変わること」と書く時で同じ ID。原文は ID に入れない）。
      // いつにするかの候補があれば、窓の日と時刻は候補が持つ（一つの命令で候補も置く）。
      const candidates = command.candidates;
      if (candidates !== undefined && command.interpretation.shape !== 'window') {
        return { status: 'invalid', reason: 'candidatesNeedWindow' };
      }
      const checked = checkNeed(state.household, command.interpretation, candidates !== undefined);
      if ('reason' in checked) return checked;
      const placed = candidates === undefined ? undefined : placeCandidates([], [], candidates);
      if (placed !== undefined && 'reason' in placed) return placed;
      const sourceId = `f-${sha256Of({
        by: me,
        text: command.text,
        interpretation: command.interpretation,
        at: plan.throughSeq,
      }).slice(0, 16)}`;
      if (state.sources.has(sourceId)) return { bodies: [] };
      const sentenceId = `${sourceId}#1`;
      const speaker = state.household?.members.find((m) => m.id === me);
      return {
        bodies: [
          {
            type: 'noticeReceived',
            source: {
              id: sourceId,
              version: 1,
              receivedAt: context.now,
              sender: 'family',
              language: speaker?.uiLanguage ?? 'ja',
              medium: 'text',
              sentences: [{ id: sentenceId, text: command.text }],
            },
          },
          {
            type: 'itemsStated',
            sourceId,
            items: [
              {
                id: `${sourceId}:i1`,
                sourceId,
                sentenceIds: [sentenceId],
                kind: 'need',
                written: command.text,
                interpretation: checked.interpretation,
                evidence: 'stated',
                effects: [],
              },
            ],
          },
          ...(placed === undefined
            ? []
            : [
                {
                  type: 'needCandidatesSet' as const,
                  itemId: `${sourceId}:i1`,
                  candidates: placed.candidates,
                },
              ]),
        ],
      };
    }
    case 'addThing': {
      // 一言の「すること」を一度に足す：言明（stateNeed）・自分たちで済ませるやり方（家に無ければ足す）の選び
      // （setNeedWays）・本命と担当の提案（chooseOption）を、同じ展開を順に通して、一つの命令の事象にする。途中の
      // 計画は、それまでの事象を足した状態から作る（書く時と見る時で同じ）。どれかが断れば、何も書かない。
      const household = state.household;
      if (!household) return { status: 'invalid', reason: 'householdMissing' };
      if (!adultOf(state, command.assigneeId)) {
        return { status: 'invalid', reason: 'assigneeNotAnAdult' };
      }
      if (household.stoppedWayIds?.includes(SELF_WAY_ID)) {
        return { status: 'invalid', reason: 'wayInactive' };
      }
      // 家にあるやり方を使うのは、家族が済ませる一つの手順のままの時だけ（「うちのこと」で頼む相手・場所・決まった人
      // などのある形に直されていれば、一言の「すること」に黙って当てない。直したやり方は、詳しい表で選べる）。
      const existing = household.ways.find((w) => w.id === SELF_WAY_ID);
      if (existing && !selfWayFits(existing)) {
        return { status: 'invalid', reason: 'selfWayChanged' };
      }
      const tz = household.timeZone;
      // 時刻の無い締切は、その日のうち（stateNeed の deadlineDayOnly と同じ）。もう過ぎた締切は足さない。
      const deadline = zonedToEpochMinutes(command.date, command.byTime ?? '00:00', tz);
      const last = command.byTime === undefined ? deadline + 24 * 60 : deadline;
      if (last <= toEpochMinutes(context.now)) return { status: 'invalid', reason: 'thingPast' };
      const bodies: EventBody[] = [];
      let at: Now = { plan, state, events };
      const take = (more: readonly EventBody[]) => {
        bodies.push(...more);
        const all = [...events, ...asEvents(events, bodies, me, context.now)];
        const folded = foldEvents(all);
        at = { events: all, state: folded, plan: planFromState(folded, context.now, context.maps) };
      };
      if (!household.ways.some((w) => w.id === SELF_WAY_ID)) {
        const way: Way = {
          id: SELF_WAY_ID,
          name: command.wayName,
          steps: [
            {
              id: 'do',
              name: command.stepName,
              durationMin: 15,
              segments: ['home', 'work'],
              waitAfterMin: 0,
            },
          ],
          cost: { leaveMinutes: 0, helperRequests: 0, yen: 0, extraTasks: 0 },
        };
        take([
          { type: 'householdSet', household: { ...household, ways: [...household.ways, way] } },
        ]);
      }
      const stated = expand(at, context, {
        type: 'stateNeed',
        text: command.text,
        interpretation: {
          what: command.text,
          shape: 'by',
          date: command.date,
          deadline: formatDateTime(deadline, tz),
          ...(command.byTime === undefined ? { deadlineDayOnly: true as const } : {}),
        },
      });
      if ('reason' in stated) return stated;
      const said = stated.bodies.find((b) => b.type === 'itemsStated');
      const itemId = said?.type === 'itemsStated' ? said.items[0]?.id : undefined;
      if (itemId === undefined) return { status: 'conflict', reason: 'thingAlready' };
      take(stated.bodies);
      const ways = expand(at, context, { type: 'setNeedWays', itemId, wayIds: [SELF_WAY_ID] });
      if ('reason' in ways) return ways;
      take(ways.bodies);
      const arrangement = at.plan.arrangements.find(
        (a) =>
          a.kind === 'need' &&
          at.plan.requirements.some(
            (r) => r.key === a.requirementKey && r.basis.itemIds.includes(itemId),
          ),
      );
      const option = arrangement?.options.find((o) => o.templateId === SELF_WAY_ID);
      if (!arrangement || !option) return { status: 'conflict', reason: 'thingUnplanned' };
      const chosen = expand(at, context, {
        type: 'chooseOption',
        arrangementKey: arrangement.key,
        optionKey: option.key,
        role: 'primary',
        assigneeId: command.assigneeId,
      });
      if ('reason' in chosen) return chosen;
      return { bodies: [...bodies, ...chosen.bodies] };
    }
    case 'setNeedWays': {
      // 家族が「すること」に使うやり方を選ぶ。選んだ時の中身とやり方の版を控える（替われば当てない）。
      const item = liveItems(state).find((l) => l.item.id === command.itemId)?.item;
      if (item?.kind !== 'need') return { status: 'conflict', reason: 'needGone' };
      const ways = state.household?.ways ?? [];
      if (
        new Set(command.wayIds).size !== command.wayIds.length ||
        command.wayIds.some((id) => !ways.some((w) => w.id === id))
      ) {
        return { status: 'invalid', reason: 'wayUnknown' };
      }
      // やめたやり方は、新しくは選べない（今の選びに入っていれば、残してよい。選び直しで外せる）。
      const current = state.needWays.get(command.itemId);
      const kept =
        current !== undefined &&
        needWaysBasis(state, command.itemId, current.wayIds) === current.about
          ? current.wayIds
          : [];
      const stopped = state.household?.stoppedWayIds ?? [];
      if (command.wayIds.some((id) => stopped.includes(id) && !kept.includes(id))) {
        return { status: 'invalid', reason: 'wayInactive' };
      }
      const about = needWaysBasis(state, command.itemId, command.wayIds);
      if (about === undefined) return { status: 'conflict', reason: 'needGone' };
      if (current?.about === about && sameJson(current.wayIds, command.wayIds))
        return { bodies: [] };
      return {
        bodies: [{ type: 'needWaysSet', itemId: command.itemId, wayIds: command.wayIds, about }],
      };
    }
    case 'setNeedCandidates': {
      const need = statedNeed(state, command.itemId);
      if ('reason' in need) return need;
      if (need.item.interpretation.shape !== 'window') {
        return { status: 'invalid', reason: 'candidatesNeedWindow' };
      }
      const before = state.needCandidates.get(command.itemId) ?? [];
      const placed = placeCandidates(
        before,
        usedCandidateIds(events, command.itemId),
        command.candidates,
      );
      if ('reason' in placed) return placed;
      // 使った後（送った・引き受けた・済ませた）は、決めた候補をそのままにする時だけ受ける：決めた候補の時刻を直す・
      // 消すのも、候補の無かった前からの「すること」に候補を足すのも断る（日を替えて、引き受けた作業を黙って別の日に
      // 動かさない。この版の限り。替えるなら外して作り直す）。
      if (needArrangementInUse(state, keys.needArrangement(need.rootId))) {
        const decided = whenOf(plan, command.itemId)?.chosen;
        const kept = decided && placed.candidates.find((c) => c.id === decided.candidateId);
        if (!decided || !kept || kept.rev !== decided.rev) {
          return { status: 'conflict', reason: 'decisionInUse' };
        }
      }
      if (sameJson(before, placed.candidates)) return { bodies: [] };
      return {
        bodies: [
          { type: 'needCandidatesSet', itemId: command.itemId, candidates: placed.candidates },
        ],
      };
    }
    case 'setNeedPeople': {
      const need = statedNeed(state, command.itemId);
      if ('reason' in need) return need;
      const household = state.household;
      const members = household?.members ?? [];
      if (
        new Set(command.members).size !== command.members.length ||
        command.members.some((id) => {
          const m = members.find((x) => x.id === id);
          return !m?.active || (m.kind !== 'adult' && m.kind !== 'helper');
        })
      ) {
        return { status: 'invalid', reason: 'personUnknown' };
      }
      const before = state.needPeople.get(command.itemId);
      const guestsBefore = new Map(
        (before?.people ?? []).filter((p) => p.kind === 'guest').map((p) => [p.id, p]),
      );
      if (command.guests.some((g) => g.id !== undefined && !guestsBefore.has(g.id))) {
        return { status: 'invalid', reason: 'personUnknown' };
      }
      const people = [
        ...command.members.map((id) => ({ id, kind: 'member' as const })),
        ...command.guests.map((g) => ({
          id: g.id ?? `g-${randomBytes(4).toString('hex')}`,
          kind: 'guest' as const,
          name: g.name,
        })),
      ];
      const ids = new Set(people.map((p) => p.id));
      if (ids.size !== people.length) return { status: 'invalid', reason: 'personDuplicate' };
      if (
        new Set(command.required).size !== command.required.length ||
        command.required.some((id) => !ids.has(id))
      ) {
        return { status: 'invalid', reason: 'requiredNotInPeople' };
      }
      if (command.minCount > people.length)
        return { status: 'invalid', reason: 'minCountTooLarge' };
      if (
        before &&
        sameJson(before.people, people) &&
        sameJson(before.required, command.required) &&
        before.minCount === command.minCount
      ) {
        return { bodies: [] };
      }
      // 名簿から外した人のリンクは止める（戻してもリンクは戻らない。出し直す）。
      const revoked: EventBody[] = [];
      for (const [personId, link] of state.answerLinks.get(command.itemId) ?? []) {
        if (!ids.has(personId) && !link.revoked) {
          revoked.push({
            type: 'answerLinkRevoked',
            itemId: command.itemId,
            personId,
            linkId: link.linkId,
          });
        }
      }
      return {
        bodies: [
          {
            type: 'needPeopleSet',
            itemId: command.itemId,
            people,
            required: command.required,
            minCount: command.minCount,
          },
          ...revoked,
        ],
      };
    }
    case 'recordAvailability': {
      const need = statedNeed(state, command.itemId);
      if ('reason' in need) return need;
      const candidate = (state.needCandidates.get(command.itemId) ?? []).find(
        (c) => c.id === command.candidateId,
      );
      if (!candidate || candidate.rev !== command.rev) {
        return { status: 'conflict', reason: 'candidateChanged' };
      }
      const roster = state.needPeople.get(command.itemId);
      if (!roster?.people.some((p) => p.id === command.personId)) {
        return { status: 'invalid', reason: 'personUnknown' };
      }
      if (command.answer === 'withdrawn' && command.note !== undefined) {
        return { status: 'invalid', reason: 'noteWithoutAnswer' };
      }
      return {
        bodies: [
          {
            type: 'availabilityRecorded',
            itemId: command.itemId,
            candidateId: command.candidateId,
            rev: command.rev,
            personId: command.personId,
            answer: command.answer,
            ...(command.note === undefined ? {} : { note: command.note }),
            source: command.personId === me ? 'self' : 'family',
          },
        ],
      };
    }
    case 'issueAnswerLink': {
      // 答えるリンクは、デモの家庭（架空）でだけ出す。家族の家庭には、別の門と設計が要る。
      if (!context.demo) return { status: 'forbidden', reason: 'linksDemoOnly' };
      const need = statedNeed(state, command.itemId);
      if ('reason' in need) return need;
      if (!state.needPeople.get(command.itemId)?.people.some((p) => p.id === command.personId)) {
        return { status: 'invalid', reason: 'personUnknown' };
      }
      const token = randomBytes(32).toString('base64url');
      return {
        bodies: [
          {
            type: 'answerLinkIssued',
            itemId: command.itemId,
            personId: command.personId,
            linkId: `l-${randomBytes(8).toString('hex')}`,
            tokenHash: answerTokenHash(token),
          },
        ],
        answerLink: { personId: command.personId, token },
      };
    }
    case 'revokeAnswerLink': {
      const link = state.answerLinks.get(command.itemId)?.get(command.personId);
      if (!link || link.revoked) return { bodies: [] };
      return {
        bodies: [
          {
            type: 'answerLinkRevoked',
            itemId: command.itemId,
            personId: command.personId,
            linkId: link.linkId,
          },
        ],
      };
    }
    case 'chooseCandidate': {
      const need = statedNeed(state, command.itemId);
      if ('reason' in need) return need;
      const candidate = (state.needCandidates.get(command.itemId) ?? []).find(
        (c) => c.id === command.candidateId,
      );
      if (!candidate || candidate.rev !== command.rev) {
        return { status: 'conflict', reason: 'candidateChanged' };
      }
      const when = whenOf(plan, command.itemId);
      if (!when) return { status: 'conflict', reason: 'needGone' };
      const decided = when.chosen;
      const sameDecision =
        decided?.candidateId === command.candidateId && decided.rev === command.rev;
      // 使った後（送った・引き受けた・済ませた）は、日を替えない（決めていなかった前からの物も。この版の限り。
      // 替えるなら外して作り直す）。
      if (when.inUse && !sameDecision) {
        return { status: 'conflict', reason: 'decisionInUse' };
      }
      const basis = decisionBasis({
        people: when.people.map((p) => p.id),
        required: when.required,
        minCount: when.minCount,
        answers: when.answers
          .filter((a) => a.candidateId === command.candidateId)
          .map((a) => ({ personId: a.personId, value: a.value, sources: a.sources })),
      });
      if (sameDecision && state.chosenCandidate.get(command.itemId)?.basis === basis) {
        return { bodies: [] };
      }
      return {
        bodies: [
          {
            type: 'candidateChosen',
            itemId: command.itemId,
            candidateId: command.candidateId,
            rev: command.rev,
            basis,
          },
        ],
      };
    }
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

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** 答えるリンクの鍵の要約（事象とサーバーの表は、これだけを持つ）。 */
export function answerTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 家族の言明の「すること」で、今も生きている物（候補・名簿・答え・リンク・決める命令の前提）。 */
function statedNeed(
  state: EngineState,
  itemId: string,
):
  | { item: ReturnType<typeof liveItems>[number]['item']; rootId: string }
  | { status: 'conflict' | 'invalid'; reason: string } {
  const live = liveItems(state).find((l) => l.item.id === itemId);
  if (live?.item.kind !== 'need') return { status: 'conflict', reason: 'needGone' };
  if (!state.statedSources.has(live.item.sourceId)) {
    return { status: 'invalid', reason: 'notStatedNeed' };
  }
  return { item: live.item, rootId: live.rootId };
}

/** 計画の、その「すること」のいつの段（候補の無い・無い「すること」は無し）。 */
function whenOf(plan: PlanResult, itemId: string) {
  return plan.requirements.find((r) => r.kind === 'need' && r.basis.itemIds.includes(itemId))?.when;
}

/** その事項で、これまでに使った候補の ID（消した物も。使い回さない）。 */
function usedCandidateIds(events: readonly DomainEvent[], itemId: string): string[] {
  return events.flatMap((e) =>
    e.type === 'needCandidatesSet' && e.itemId === itemId ? e.candidates.map((c) => c.id) : [],
  );
}

/**
 * 候補に ID と代を付ける。前からある候補（id 付き）は、時刻が同じなら同じ代、違えば代を一つ進める。新しい候補は、
 * これまでに使っていない番号（c1, c2…）で代 1。同じ日・同じ時刻の候補を二つ置かない。日をまたぐ候補は断る。
 */
function placeCandidates(
  before: readonly { id: string; rev: number; date: string; startTime: string; endTime: string }[],
  used: readonly string[],
  asked: readonly { id?: string; date: string; startTime: string; endTime: string }[],
):
  | {
      candidates: { id: string; rev: number; date: string; startTime: string; endTime: string }[];
    }
  | { status: 'invalid'; reason: string } {
  const invalid = (reason: string) => ({ status: 'invalid' as const, reason });
  const seen = new Set<string>();
  let next =
    Math.max(
      0,
      ...[...used, ...before.map((c) => c.id)].map((id) => Number(/^c(\d+)$/.exec(id)?.[1] ?? 0)),
    ) + 1;
  const candidates: {
    id: string;
    rev: number;
    date: string;
    startTime: string;
    endTime: string;
  }[] = [];
  for (const c of asked) {
    if (c.startTime >= c.endTime) return invalid('needWindowOvernight');
    const slot = `${c.date} ${c.startTime}-${c.endTime}`;
    if (seen.has(slot)) return invalid('candidateDuplicate');
    seen.add(slot);
    if (c.id !== undefined) {
      const prev = before.find((b) => b.id === c.id);
      if (!prev) return invalid('candidateUnknown');
      const same =
        prev.date === c.date && prev.startTime === c.startTime && prev.endTime === c.endTime;
      candidates.push({
        id: c.id,
        rev: same ? prev.rev : prev.rev + 1,
        date: c.date,
        startTime: c.startTime,
        endTime: c.endTime,
      });
    } else {
      candidates.push({
        id: `c${next++}`,
        rev: 1,
        date: c.date,
        startTime: c.startTime,
        endTime: c.endTime,
      });
    }
  }
  if (new Set(candidates.map((c) => c.id)).size !== candidates.length) {
    return invalid('candidateDuplicate');
  }
  return { candidates };
}

/**
 * 家と暮らしの情報の直しを、エンジンが正しく扱える範囲に限る（validateHousehold に加えて。02-foundation §6）。
 * - 家庭の ID・地域・時区は替えない。
 * - 成員は消さず、ID・種類・有効を替えない（ログインの身元の正本は成員の表で、大人・子は家の情報の事象では
 *   足さない。成員を止めるのは別の操作にする）。名前・言葉・送り迎えの決まりは直せる。足せるのは手伝いの人
 *   （やり方の外の相手。ログインしない）だけ。
 * - 場所は消さない（場所には止める欄が無い）。種類は替えない。店・祖母の家など・施設を足せる。営業時間は同じ日の
 *   中の区間だけ（日をまたぐ営業は、買い物の計算が正しく扱えない）。直した営業時間は、家族が確かめた物として今の
 *   時刻を付ける。
 * - 取れる手は、足さず消さず、ID の重なりも認めない。直せるのは締切の決まりの数と代償だけ（手順の形・担当・
 *   相手は替えない。新しい手は、やり方の表で足す）。
 * - やり方は、足す・直す・やめるができ、消せない（checkWays）。
 * - 大人のふだんの一日には、家にいる区間が要る（家にいる区間が一つも無い日は、子の居場所の手配の要る時間を
 *   決められない）。
 */
/**
 * 保存の前に「この変更で変わること」を見せる命令と、その要約に入れる中身（家の情報の直し・「すること」の言明・
 * やり方の選び・「すること」の直しと外し）。ほかの命令は無し。state を渡すと、書く時に見た物が要るかを決める：
 * 「すること」の直しと外しは、計画に入っている物（家族の言明か、家族が確かめた読み取り）だけ要る（まだ確かめて
 * いない読み取りは、見せた番号だけ。初めての読み取りなら計画に無く、作業も依頼も無い。読み直した後で確かめを
 * 待つ物には、前の中身で送った依頼が残ることがあるが、今は前もって見せない〔02-foundation の境〕。ほかの事項は
 * 今の決まりのまま）。
 * state が無ければ（見せる時）、要約に入れる中身だけを返す。
 */
/**
 * 自分たちで済ませるやり方が、一言の「すること」に当ててよい形か：手順が一つで、外の相手に頼まず、決まった場所・
 * 店の種類・品・決まった人・窓の受け持ち・締切の決まりが無く、やり方にも締切・受け持てる時間・前提・資源が無い。
 * 名前・かかる時間・区間・待ち時間・代償の直しはかまわない。
 */
function selfWayFits(way: Way): boolean {
  const [step, ...more] = way.steps;
  return (
    step !== undefined &&
    more.length === 0 &&
    step.external === undefined &&
    step.placeId === undefined &&
    step.placeKind === undefined &&
    step.goods === undefined &&
    step.assigneeId === undefined &&
    step.cover !== true &&
    step.deadline === undefined &&
    way.deadline === undefined &&
    way.covers === undefined &&
    (way.requires ?? []).length === 0 &&
    (way.resourceIds ?? []).length === 0
  );
}

export function previewedInput(
  command: Command,
  state?: EngineState,
): { input: unknown; seen?: { throughSeq: number; changes: string } } | undefined {
  switch (command.type) {
    case 'discardSource':
      return {
        input: { sourceId: command.sourceId, reason: command.reason },
        ...(command.seen ? { seen: command.seen } : {}),
      };
    case 'correctItem':
    case 'dismissItem': {
      if (state !== undefined) {
        const item = itemsOf(state).find((i) => i.id === command.itemId);
        if (
          (command.type === 'dismissItem' && item?.kind !== 'need') ||
          (item?.kind === 'need' && awaitingConfirmation(state, item))
        )
          return undefined;
      }
      const input =
        command.type === 'correctItem'
          ? { itemId: command.itemId, interpretation: command.interpretation }
          : { itemId: command.itemId, reason: command.reason };
      const changes = command.seen?.changes;
      return {
        input,
        ...(command.seen && changes !== undefined
          ? { seen: { throughSeq: command.seen.throughSeq, changes } }
          : {}),
      };
    }
    case 'updateHousehold':
      return { input: command.household, ...(command.seen ? { seen: command.seen } : {}) };
    case 'stateNeed':
      return {
        input: {
          text: command.text,
          interpretation: command.interpretation,
          ...(command.candidates === undefined ? {} : { candidates: command.candidates }),
        },
        ...(command.seen ? { seen: command.seen } : {}),
      };
    case 'addThing':
      return {
        input: {
          text: command.text,
          date: command.date,
          ...(command.byTime === undefined ? {} : { byTime: command.byTime }),
          assigneeId: command.assigneeId,
          wayName: command.wayName,
          stepName: command.stepName,
        },
        ...(command.seen ? { seen: command.seen } : {}),
      };
    case 'setNeedWays':
      return {
        input: { itemId: command.itemId, wayIds: command.wayIds },
        ...(command.seen ? { seen: command.seen } : {}),
      };
    case 'setNeedCandidates':
      return {
        input: { itemId: command.itemId, candidates: command.candidates },
        ...(command.seen ? { seen: command.seen } : {}),
      };
    case 'chooseCandidate':
      return {
        input: { itemId: command.itemId, candidateId: command.candidateId, rev: command.rev },
        ...(command.seen ? { seen: command.seen } : {}),
      };
    default:
      return undefined;
  }
}

/**
 * 家族の言明の「すること」の欄を確かめる（02-foundation §3.4）。window は同じ日の始まり–終わり（日をまたぐ・
 * 足りない時は断る。時刻を作らない）、by は締切が要る。だれのためは家庭の成員だけ。形に使わない欄は落とす。
 */
function checkNeed(
  household: Household | undefined,
  need: NeedInterpretation,
  /** いつにするかの候補がある（日と時刻は候補が持つ。欄にあっても落とす）。 */
  withCandidates = false,
): { interpretation: Interpretation } | { status: 'invalid'; reason: string } {
  const invalid = (reason: string) => ({ status: 'invalid' as const, reason });
  if (!household) return invalid('householdMissing');
  if (need.forMemberId !== undefined && !household.members.some((m) => m.id === need.forMemberId)) {
    return invalid('needMemberUnknown');
  }
  if (need.shape === 'window' && withCandidates) {
    const {
      deadline: _deadline,
      deadlineDayOnly: _dayOnly,
      date: _date,
      startTime: _start,
      endTime: _end,
      ...rest
    } = need;
    return { interpretation: rest };
  }
  if (need.shape === 'window') {
    if (!need.date || !need.startTime || !need.endTime) return invalid('needWindowMissing');
    if (need.startTime >= need.endTime) return invalid('needWindowOvernight');
    const { deadline: _deadline, deadlineDayOnly: _dayOnly, ...rest } = need;
    return { interpretation: rest };
  }
  if (!need.deadline) return invalid('needDeadlineMissing');
  const { startTime: _start, endTime: _end, ...rest } = need;
  return { interpretation: rest };
}

function checkHouseholdEdit(
  current: Household | undefined,
  next: Household,
  now: DateTime,
  surveyed: readonly SurveyCandidate[],
): { household: Household } | { status: 'invalid'; reason: string } {
  const invalid = (reason: string) => ({ status: 'invalid' as const, reason });
  if (!current) return invalid('householdMissing');
  if (validateHousehold(next).length > 0) return invalid('householdInvalid');
  if (
    next.id !== current.id ||
    next.region !== current.region ||
    next.timeZone !== current.timeZone ||
    next.confirmDays !== current.confirmDays
  ) {
    return invalid('householdIdentity');
  }
  for (const member of current.members) {
    const edited = next.members.find((m) => m.id === member.id);
    if (!edited || edited.kind !== member.kind || edited.active !== member.active) {
      return invalid('membersLocked');
    }
    // 習い事の送り迎えの決まりは、子の物だけ直せる（大人・手伝いの人には意味が無い）。
    if (edited.kind !== 'child' && !sameJson(edited.clubEscort, member.clubEscort)) {
      return invalid('membersLocked');
    }
  }
  // 足せる成員は、手伝いの人（やり方の外の相手。ログインしない）だけ：名前と呼び方・外に出す文の言葉。
  const memberIds = new Set(current.members.map((m) => m.id));
  const placeIds = new Set(current.places.map((p) => p.id));
  for (const member of next.members) {
    if (memberIds.has(member.id)) continue;
    if (
      member.kind !== 'helper' ||
      !member.active ||
      member.grade !== undefined ||
      member.clubEscort !== undefined ||
      !NEW_ID.test(member.id) ||
      placeIds.has(member.id) ||
      member.name.trim() === ''
    ) {
      return invalid('membersLocked');
    }
  }
  for (const place of current.places) {
    const edited = next.places.find((p) => p.id === place.id);
    if (!edited || edited.kind !== place.kind) return invalid('placesLocked');
  }
  // 足せる場所は、店・祖母の家など・施設（家・学校・駅は、家の始まりの設定で入れる）。営業時間は無くてよい（分から
  // ない：計算は営業時間で絞らず、画面は「登録なし」と書き、お勧めを出さない）。学童と職場は、同じ直しで足す学童・
  // 休みの手が相手にする時だけ足せる（ふだんの週の区間や地図には使わない）。
  const added = next.careOptions.filter((o) => !current.careOptions.some((c) => c.id === o.id));
  for (const place of next.places) {
    const newKind =
      NEW_PLACE_KINDS.has(place.kind) ||
      (CARE_PLACE_KINDS.has(place.kind) && added.some((o) => o.providerId === place.id));
    if (
      !placeIds.has(place.id) &&
      (!newKind ||
        !NEW_ID.test(place.id) ||
        memberIds.has(place.id) ||
        next.members.some((m) => m.id === place.id) ||
        place.name.trim() === '')
    ) {
      return invalid('placesLocked');
    }
    if (place.hours?.periods.some((p) => p.open >= p.close)) return invalid('hoursOvernight');
  }
  // 家族に見せる名前（成員と場所）を新しく重ねない：同じ名前の人・場所があると、画面でどれのことか見分けられず、
  // 別の人に頼むことがある。前からある重なり（同じ物どうしの組）だけなら断らない（ほかの欄の直しを止めない）。
  // 前からある重なりの名前へ別の物を入れる（足す・名前を変えて入れる・一人と入れ替える）のは、新しい組なので断る。
  const pairsBefore = sameNamePairs(current);
  if ([...sameNamePairs(next)].some((pair) => !pairsBefore.has(pair))) return invalid('nameTaken');
  const ids = next.careOptions.map((o) => o.id);
  // 新しく足せる取れる手は、決まった形の三つだけ：頼める人に頼む（頼める人一人に一つ）、学童に一日預ける（学童一つに
  // 一つ）、大人が休む（大人一人に一つ）。家族が選ぶのは締切と、学童の費用・見てもらえる時間・お弁当だけ。
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== current.careOptions.length + added.length ||
    added.some(
      (o) => !helperAskAllowed(o, next) && !afterSchoolAllowed(o, next) && !leaveAllowed(o, next),
    )
  ) {
    return invalid('careOptionsLocked');
  }
  for (const option of current.careOptions) {
    const edited = next.careOptions.find((o) => o.id === option.id);
    if (!edited) return invalid('careOptionsLocked');
    const { deadline: _d, cost: _c, covers: before, ...rest } = option;
    const { deadline: _d2, cost: _c2, covers: after, ...editedRest } = edited;
    if (!sameJson(rest, editedRest)) return invalid('careOptionsLocked');
    // 学童に一日預ける手は、見てもらえる時間も直せる（入れ間違い・学童の時間が変わった時。前からの記録で無ければ
    // 足せる）。同じ日の中で、始まりが終わりより前の時刻の区間だけ（外す・一日の全部にはしない）。ほかの手の見て
    // もらえる時間は替えない。
    const hours =
      option.kind === 'afterSchoolFullDay' && typeof after === 'object' && after.start < after.end;
    if (!sameJson(before ?? null, after ?? null) && !hours) return invalid('careOptionsLocked');
    // 代償の「分からない」は、家族が足すやり方だけ（取れる手の勧め方と選び直しの札を替えない）。
    if (edited.cost.unknown !== undefined) return invalid('careOptionsLocked');
  }
  // 使えないとした手は、前からある取れる手だけを、足すことだけできる（外して戻さない。重ねない）。
  const unusableBefore = current.unusableCareOptionIds ?? [];
  const unusableAfter = next.unusableCareOptionIds ?? [];
  if (
    new Set(unusableAfter).size !== unusableAfter.length ||
    unusableBefore.some((id) => !unusableAfter.includes(id)) ||
    unusableAfter.some((id) => !current.careOptions.some((o) => o.id === id))
  ) {
    return invalid('careOptionsLocked');
  }
  const ways = checkWays(current, next);
  if ('reason' in ways) return ways;
  const around = checkResources(current, next, now, surveyed);
  if ('reason' in around) return around;
  // 大人のふだんの一日：前からある曜日は消さず（区間の無い日にしない）、直した日は区間を切れ目なく続ける
  // （書かれていない時間を作らない）。分からない時間で、子の居場所の手配が要る時間を決めないため。
  const adults = new Set(next.members.filter((m) => m.kind === 'adult').map((m) => m.id));
  const dayOf = (h: Household, memberId: string, weekday: number) =>
    h.routines.find((d) => d.memberId === memberId && d.weekday === weekday);
  for (const day of current.routines) {
    if (!adults.has(day.memberId)) continue;
    if (!dayOf(next, day.memberId, day.weekday)?.segments.length) {
      return invalid('routineDayMissing');
    }
  }
  // 過ごし方と場所を食い違わせない：「家」は家の場所、外出・迎えは家以外（家で仕事をするのは受ける）。
  const homes = new Set(next.places.filter((p) => p.kind === 'home').map((p) => p.id));
  const badDay = (segments: Household['routines'][number]['segments']) => {
    if (segments.some((s, i) => i > 0 && s.start !== segments[i - 1]?.end)) return 'routineGap';
    const mismatch = segments.some(
      (s) =>
        s.placeId !== undefined &&
        ((s.kind === 'home' && !homes.has(s.placeId)) ||
          ((s.kind === 'away' || s.kind === 'pickup') && homes.has(s.placeId))),
    );
    return mismatch ? 'routinePlace' : undefined;
  };
  // 空から始めた家庭（confirmDays）では、足した・直した日の記録に、家族が一日の全部を確かめて記録した印が要る
  // （記録した大人本人が答えた・確かめたとは言わない。だれが記録したかは事象に残る）。
  for (const day of next.routines) {
    if (!adults.has(day.memberId)) continue;
    const before = dayOf(current, day.memberId, day.weekday);
    if (sameJson(before, day)) continue;
    if (next.confirmDays && day.allDay !== true) return invalid('dayNotConfirmed');
    if (sameJson(before?.segments, day.segments)) continue;
    const bad = badDay(day.segments);
    if (bad) return invalid(bad);
  }
  // その日だけの一日も、大人の物だけを、ふだんの一日と同じ決まりで受ける（直した・足した物を確かめる）。
  for (const day of next.routineExceptions) {
    const before = current.routineExceptions.find(
      (e) => e.memberId === day.memberId && e.date === day.date,
    );
    if (next.confirmDays && !sameJson(before, day) && day.allDay !== true) {
      return invalid('dayNotConfirmed');
    }
    if (sameJson(before?.segments, day.segments)) continue;
    if (!adults.has(day.memberId)) return invalid('routineExceptionMember');
    const bad = badDay(day.segments);
    if (bad) return invalid(bad);
  }
  // その日に子を見られるかの答えは、今いる大人の物だけ（形は validateHousehold が確かめる）。
  const active = new Set(
    next.members.filter((m) => m.kind === 'adult' && m.active).map((m) => m.id),
  );
  if ((next.dayAnswers ?? []).some((a) => !active.has(a.memberId))) {
    return invalid('dayAnswerMember');
  }
  // 営業時間の調べた所と時刻はサーバーが持つ：時間（曜日ごとの区間・休みの日）を直していなければ、今の記録の
  // 物をそのまま使う（送られた調べた所・時刻は採らない）。直した・新しく入れた時間は、家族が確かめた物として
  // 今の時刻を付ける。
  const places = next.places.map((place) => {
    const before = current.places.find((p) => p.id === place.id);
    const same =
      sameJson(before?.hours?.periods, place.hours?.periods) &&
      sameJson(before?.hours?.closedDates, place.hours?.closedDates);
    if (same) {
      const { hours: _sent, ...rest } = place;
      return before?.hours ? { ...rest, hours: before.hours } : rest;
    }
    if (!place.hours) return place;
    return { ...place, hours: { ...place.hours, source: 'family' as const, checkedAt: now } };
  });
  const { stoppedWayIds: _sent, ...rest } = next;
  return {
    household: {
      ...rest,
      places,
      resources: around.resources,
      preparations: around.preparations,
      ways: ways.ways,
      ...(ways.stoppedWayIds === undefined ? {} : { stoppedWayIds: ways.stoppedWayIds }),
    },
  };
}

/**
 * 周りの資源と、一度だけ済ませておく前提の直し（02-foundation §3.5）。消さない。前からある物で直せるのは、家族の扱い
 * （いつも・候補・使わない）と、前提のだれの分（家全体・その人たち・分からない）・状態・有効な最後の日だけで、ほかの
 * 欄（名前・種類・出典・家族が確かめた日数）は替えない。新しく入れられるのは、このデモで調べて見せた候補と同じ中身の
 * 資源と、その資源の前提の案だけ（扱い・だれの分・状態・有効な最後の日は家族が選ぶ。前提は、家族が「要る」と確かめた
 * 時に画面が足す）。直した・入れた時刻はサーバーが付ける（送られた時刻は採らない）。だれの分の人は、家の成員だけ
 * （validateHousehold が確かめる）。
 */
function checkResources(
  current: Household,
  next: Household,
  now: DateTime,
  surveyed: readonly SurveyCandidate[],
):
  | { resources: Household['resources']; preparations: Household['preparations'] }
  | { status: 'invalid'; reason: string } {
  const invalid = (reason: string) => ({ status: 'invalid' as const, reason });
  if (
    current.resources.some((r) => !next.resources.some((n) => n.id === r.id)) ||
    current.preparations.some((p) => !next.preparations.some((n) => n.id === p.id))
  ) {
    return invalid('resourcesLocked');
  }
  const resources: Household['resources'] = [];
  for (const sent of next.resources) {
    const { use, decidedAt: _decidedAt, ...rest } = sent;
    const before = current.resources.find((r) => r.id === sent.id);
    if (before) {
      const { use: beforeUse, decidedAt, ...beforeRest } = before;
      // 場所に結んでいない資源だけ、家族が後から、名前が同じで家ではない場所に結べる（結んだ場所は替えない）。
      const { placeId, ...sentRest } = rest;
      const linked =
        before.placeId === undefined && placeId !== undefined
          ? next.places.find((p) => p.id === placeId)
          : undefined;
      if (linked) {
        if (
          linked.kind === 'home' ||
          linked.name !== before.name ||
          !sameJson(sentRest, beforeRest)
        ) {
          return invalid('resourcesLocked');
        }
        const kept = use === beforeUse ? { decidedAt } : { decidedAt: now };
        resources.push({ ...beforeRest, placeId, use, ...(kept.decidedAt ? kept : {}) });
        continue;
      }
      if (!sameJson(rest, beforeRest)) return invalid('resourcesLocked');
      resources.push(use === beforeUse ? before : { ...beforeRest, use, decidedAt: now });
      continue;
    }
    // 家族が家の店から作る店の資源（好み）：店の場所を指し、ID は店から決め、名前は店の名前、分かった事は無し。
    // 一つの店に一つ（扱いの食い違う二つを作らない）。扱いは家族が選ぶ。
    const store =
      sent.kind === 'store'
        ? next.places.find((p) => p.kind === 'store' && p.id === sent.placeId)
        : undefined;
    if (store) {
      const { placeId: _placeId, ...own } = rest;
      if (
        !sameJson(own, {
          id: `res-store-${store.id}`,
          kind: 'store',
          name: store.name,
          notes: [],
        }) ||
        next.resources.filter((r) => r.placeId === store.id).length > 1
      ) {
        return invalid('resourcesLocked');
      }
      resources.push({ ...rest, use, decidedAt: now });
      continue;
    }
    const shown = surveyed.find((c) => c.resource.id === sent.id);
    if (!shown) return invalid('resourcesLocked');
    const { use: _shownUse, decidedAt: _shownAt, ...shownRest } = shown.resource;
    // 地図の場所（placeId）は家族が結ぶ：同じ直しで足す場所か家にある場所で、家ではなく、名前が資源と同じ物だけ
    // （やり方の手順は場所に頼む・行くので、資源を手順に結ぶ時の手がかり）。ほかの欄は、見せた候補のまま。
    const { placeId, ...sentRest } = rest;
    if (!sameJson(sentRest, shownRest)) return invalid('resourceNotAsSurveyed');
    if (placeId !== undefined) {
      const place = next.places.find((p) => p.id === placeId);
      if (!place || place.kind === 'home' || place.name !== sent.name) {
        return invalid('resourceNotAsSurveyed');
      }
    }
    resources.push({
      ...shownRest,
      ...(placeId === undefined ? {} : { placeId }),
      use,
      decidedAt: now,
    });
  }
  const preparations: Household['preparations'] = [];
  for (const sent of next.preparations) {
    const { state, validUntil, stateCheckedAt: _checked, appliesTo, ...rest } = sent;
    const before = current.preparations.find((p) => p.id === sent.id);
    if (before) {
      const {
        state: beforeState,
        validUntil: beforeValid,
        stateCheckedAt,
        appliesTo: beforeApplies,
        ...beforeRest
      } = before;
      if (!sameJson(rest, beforeRest)) return invalid('resourcesLocked');
      // 確かめた時刻は、状態か有効な最後の日を直した時だけ付け直す（だれの分だけの直しでは、状態を確かめていない）。
      const sameState = state === beforeState && validUntil === beforeValid;
      if (sameState && sameJson(appliesTo, beforeApplies)) {
        preparations.push(before);
        continue;
      }
      preparations.push({
        ...beforeRest,
        appliesTo,
        state,
        ...(validUntil === undefined ? {} : { validUntil }),
        ...(sameState
          ? stateCheckedAt === undefined
            ? {}
            : { stateCheckedAt }
          : { stateCheckedAt: now }),
      });
      continue;
    }
    // 新しい前提は、調べた候補の前提の案（出典の無い案を含む）で、その資源が家にある（同じ直しで入れる物も含む）時だけ。
    const shown = surveyed.map(surveyPreparation).find((p) => p.id === sent.id);
    if (!shown || !resources.some((r) => r.id === shown.resourceId)) {
      return invalid('resourcesLocked');
    }
    const {
      state: shownState,
      validUntil: _v,
      stateCheckedAt: _s,
      appliesTo: _a,
      ...shownRest
    } = shown;
    if (!sameJson(rest, shownRest)) return invalid('resourceNotAsSurveyed');
    preparations.push({
      ...shownRest,
      appliesTo,
      state,
      ...(validUntil === undefined ? {} : { validUntil }),
      // 家族が状態を選んだ時だけ、確かめた時刻を付ける（案のまま「分からない」なら付けない）。
      ...(state === shownState && validUntil === undefined ? {} : { stateCheckedAt: now }),
    });
  }
  return { resources, preparations };
}

/** 新しく足す成員・場所・やり方・手順の ID（画面が作る。ID は比べるだけで、区切って読まない。これは守りの形）。 */
const NEW_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** 家族が使えないとしていない取れる手（頼める人・学童・大人ごとに一つまでを数える時は、これだけを数える）。 */
function usableOptions(household: Household): CareOptionTemplate[] {
  const unusable = new Set(household.unusableCareOptionIds ?? []);
  return household.careOptions.filter((o) => !unusable.has(o.id));
}

/**
 * 家族が足す取れる手が、頼める人に頼む決まった形か（helperAskOption と同じ中身。締切は選べる物だけ）。頼める人は今いる
 * 手伝いの人で、その人に頼む手は一つだけ。
 */
function helperAskAllowed(option: CareOptionTemplate, next: Household): boolean {
  const helper = next.members.find(
    (m) => m.id === option.providerId && m.kind === 'helper' && m.active,
  );
  const days = option.deadline.type === 'daysBefore' ? option.deadline.days : undefined;
  const allowed = HELPER_ASK_DAYS.find((d) => d === days);
  return (
    helper !== undefined &&
    allowed !== undefined &&
    NEW_ID.test(option.id) &&
    sameJson(option, helperAskOption(option.id, helper.id, allowed)) &&
    usableOptions(next).filter((o) => o.kind === 'askHelper' && o.providerId === helper.id)
      .length === 1
  );
}
const NEW_PLACE_KINDS: ReadonlySet<PlaceKind> = new Set(['store', 'helperHome', 'other']);
/** 足す学童・休みの手の相手としてだけ足せる場所の種類。 */
const CARE_PLACE_KINDS: ReadonlySet<PlaceKind> = new Set(['afterSchoolCare', 'workplace']);
/** 家族が入れる学童の一日の費用の上限（円。打ち間違いで、桁の違う代償で比べない）。 */
const MAX_CARE_YEN = 100_000;

/**
 * 家族が足す取れる手が、学童に一日預ける決まった形か（afterSchoolOption と同じ中身。締切・費用・お弁当・一日利用で
 * 見てもらえる時間を家族が入れる）。学童は今ある学童の場所で、その学童に預ける手は一つだけ。締切は 1〜30 日前か、
 * 前の週の月〜土の時刻（分まで）。見てもらえる時間は、同じ日の中で始まりが終わりより前。
 */
function afterSchoolAllowed(option: CareOptionTemplate, next: Household): boolean {
  const place = next.places.find((p) => p.id === option.providerId && p.kind === 'afterSchoolCare');
  const rule = option.deadline;
  let deadline: AfterSchoolDeadline | undefined;
  if (rule.type === 'weekdayOfPreviousWeek') {
    const weekday = AFTER_SCHOOL_WEEKDAYS.find((w) => w === rule.weekday);
    if (weekday !== undefined) deadline = { type: rule.type, weekday, at: rule.at };
  } else if (rule.type === 'daysBefore' && careDays(rule.days, AFTER_SCHOOL_MAX_DAYS)) {
    deadline = { type: rule.type, days: rule.days, at: rule.at };
  }
  const covers = option.covers;
  return (
    place !== undefined &&
    deadline !== undefined &&
    typeof covers === 'object' &&
    covers.start < covers.end &&
    option.cost.yen <= MAX_CARE_YEN &&
    NEW_ID.test(option.id) &&
    sameJson(
      option,
      afterSchoolOption(
        option.id,
        place.id,
        deadline,
        option.cost.yen,
        option.extraSteps.length > 0,
        covers,
      ),
    ) &&
    usableOptions(next).filter((o) => o.kind === 'afterSchoolFullDay' && o.providerId === place.id)
      .length === 1
  );
}

/**
 * 家族が足す取れる手が、大人が休む決まった形か（leaveOption と同じ中身。締切だけ家族が選ぶ：1〜10 営業日前の
 * 時刻、分まで）。休むのは今いる大人で、相手は職場の場所。その大人が休む手は一つだけ。
 */
function leaveAllowed(option: CareOptionTemplate, next: Household): boolean {
  const adultId = option.steps[0]?.assigneeId;
  const adult = next.members.find((m) => m.id === adultId && m.kind === 'adult' && m.active);
  const place = next.places.find((p) => p.id === option.providerId && p.kind === 'workplace');
  const rule = option.deadline;
  if (rule.type !== 'businessDaysBefore' || !adult || !place) return false;
  return (
    careDays(rule.days, LEAVE_MAX_BUSINESS_DAYS) &&
    NEW_ID.test(option.id) &&
    sameJson(option, leaveOption(option.id, adult.id, place.id, rule.days, rule.at)) &&
    usableOptions(next).filter((o) => o.kind === 'paidLeave' && o.steps[0]?.assigneeId === adult.id)
      .length === 1
  );
}
/** 手順のかかる時間・返事を待つ時間の上限（分。打ち間違いで、何日も先の置き方を探さない）。 */
const MAX_STEP_MIN = 24 * 60;
const MAX_WAIT_MIN = 7 * 24 * 60;

/**
 * やり方の直し（02-foundation §3.4・§6）。消さない（前の ID は全部残る。使わないなら、やめた物の一覧に入れる）。
 * 足した・直したやり方は：名前と手順の題があり、手順の ID は重ならず、担当は今いる大人、外の相手は手伝いの人か家
 * 以外の場所、決まった場所は家以外。費用の「分からない」は四つの欄の中で重ならず、その欄の値は 0。直していない
 * やり方は、そのまま（初めに入れた家の情報の版を替えない）。空の「分からない」は欄が無いのと同じなので書かない
 * （版を揃える）。やめた物の一覧は、あるやり方の ID だけで、重ならない（空なら書かない）。
 */
function checkWays(
  current: Household,
  next: Household,
): { ways: Way[]; stoppedWayIds: string[] | undefined } | { status: 'invalid'; reason: string } {
  const invalid = (reason: string) => ({ status: 'invalid' as const, reason });
  if (current.ways.some((way) => !next.ways.some((w) => w.id === way.id))) {
    return invalid('wayRemoved');
  }
  const stopped = next.stoppedWayIds ?? [];
  if (
    new Set(stopped).size !== stopped.length ||
    stopped.some((id) => !next.ways.some((w) => w.id === id))
  ) {
    return invalid('wayInvalid');
  }
  const adults = new Set(
    next.members.filter((m) => m.kind === 'adult' && m.active).map((m) => m.id),
  );
  const outside = new Set([
    ...next.members.filter((m) => m.kind === 'helper' && m.active).map((m) => m.id),
    ...next.places.filter((p) => p.kind !== 'home').map((p) => p.id),
  ]);
  const places = new Set(next.places.filter((p) => p.kind !== 'home').map((p) => p.id));
  // 同じ名前の人・場所（前からある重なり）は、新しく選ばせない（画面で見分けられない）。前から選んであった物は残せる。
  const repeated = repeatedNames(next);
  const ambiguous = (id: string | undefined) => {
    if (id === undefined) return false;
    const name =
      next.members.find((m) => m.id === id)?.name ?? next.places.find((p) => p.id === id)?.name;
    return name !== undefined && repeated.has(shownName(name));
  };
  const ways: Way[] = [];
  for (const sent of next.ways) {
    const way = tidyWay(sent);
    const before = current.ways.find((w) => w.id === way.id);
    if (before && sameJson(tidyWay(before), way)) {
      ways.push(before);
      continue;
    }
    if (!before && !NEW_ID.test(way.id)) return invalid('wayInvalid');
    if (way.name.trim() === '') return invalid('wayInvalid');
    // やり方の前提（requires）と使う資源（resourceIds）は、家にある前提・資源を指す時だけ（validateHousehold が確かめる）。
    for (const step of way.steps) {
      if (!NEW_ID.test(step.id) || step.name.trim() === '') return invalid('wayInvalid');
      if (new Set(step.segments).size !== step.segments.length) return invalid('wayInvalid');
      if (step.durationMin > MAX_STEP_MIN || step.waitAfterMin > MAX_WAIT_MIN) {
        return invalid('wayInvalid');
      }
      if (step.assigneeId !== undefined && !adults.has(step.assigneeId)) {
        return invalid('wayRefUnknown');
      }
      if (step.external !== undefined && !outside.has(step.external.to)) {
        return invalid('wayRefUnknown');
      }
      if (step.placeId !== undefined && !places.has(step.placeId)) return invalid('wayRefUnknown');
      const old = before?.steps.find((s) => s.id === step.id);
      if (
        (ambiguous(step.assigneeId) && step.assigneeId !== old?.assigneeId) ||
        (ambiguous(step.external?.to) && step.external?.to !== old?.external?.to) ||
        (ambiguous(step.placeId) && step.placeId !== old?.placeId)
      ) {
        return invalid('nameTaken');
      }
    }
    const unknown = way.cost.unknown ?? [];
    if (
      new Set(unknown).size !== unknown.length ||
      unknown.some((field) => way.cost[field] !== 0)
    ) {
      return invalid('wayInvalid');
    }
    ways.push(way);
  }
  return { ways, stoppedWayIds: stopped.length > 0 ? stopped : undefined };
}

/** 空の「分からない」を落とす（欄が無いのと同じ意味。版を揃える）。 */
function tidyWay(way: Way): Way {
  const { unknown, ...cost } = way.cost;
  const { requires, resourceIds, ...rest } = way;
  // 空の前提・使う資源は、欄が無いのと同じなので書かない（版を揃える）。
  return {
    ...rest,
    ...(requires === undefined || requires.length === 0 ? {} : { requires }),
    ...(resourceIds === undefined || resourceIds.length === 0 ? {} : { resourceIds }),
    cost: unknown === undefined || unknown.length === 0 ? cost : { ...cost, unknown },
  };
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

/**
 * 家庭の決まりで、その手順をする本人が決まっていれば、その人（自分の有休の申請、やり方の受け持ちの担当など）。
 * 取れる手（子の居場所）とやり方（通用の「すること」）の両方を見る。
 */
function fixedAssigneeOf(
  state: EngineState,
  task: {
    step?: { templateId: string; stepId: string } | undefined;
    basis: { arrangementKey?: string | undefined };
  },
): string | undefined {
  if (!task.step) return undefined;
  const { templateId, stepId } = task.step;
  // 作業の手配の種類で、取れる手かやり方かを決める（ID が二つの集まりで同じでも、別の型の手順を当てない）。
  const templates = isNeedArrangementKey(task.basis.arrangementKey)
    ? state.household?.ways
    : state.household?.careOptions;
  return templates?.find((o) => o.id === templateId)?.steps.find((s) => s.id === stepId)
    ?.assigneeId;
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
