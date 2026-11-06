// 知らせを送る前に、受け取った意図と、最後に送る固定文を独立に照らす。
// 計画の検証は verifyPlan の責務。ここでは知らせに固有の条件を確かめる。

import type { Arrangement, Household as Family, PlanResult as Plan, Task } from '@maniau/core';
import { DateTime, DomainEvent, Household, PlanResult, toEpochMinutes } from '@maniau/core';
import { collectFacts, type FactState } from './facts';
import { checkHistory } from './history';
import { checkNeedWhen } from './need-when';
import { type NeedWindows, needWindows, timedNeedItem } from './need-window';
import { needDeadline, statedWindow } from './plan';
import { Collector, type VerificationReport } from './report';
import { matchesArrangementDay, matchesArrangementWindow } from './time';

const ALL = '$all';
type Title =
  | 'notify.cancel'
  | 'notify.check'
  | 'notify.backup'
  | 'notify.noReply'
  | 'notify.decide'
  | 'notify.proposal'
  | 'notify.changed'
  | 'notify.released'
  | 'notify.releasedCheck'
  | 'notify.unowned'
  | 'notify.question'
  | 'notify.readCheck'
  | 'notify.need'
  | 'notify.needGaps';
type Subject = {
  type: 'task' | 'request' | 'arrangement' | 'question' | 'reading';
  id: string;
  seq?: number;
  optionId?: string;
  requestId?: string;
};
type Intent = {
  key: string;
  toMemberId: string;
  kind: string;
  titleKey: Title;
  subject: Subject;
  until?: string;
  actBy?: string;
};

const titles: Record<Title, string> = {
  'notify.cancel': 'cancellation',
  'notify.check': 'question',
  'notify.backup': 'decisionApproaching',
  'notify.noReply': 'decisionApproaching',
  'notify.decide': 'decisionApproaching',
  'notify.proposal': 'assignment',
  'notify.changed': 'assignment',
  'notify.released': 'assignment',
  'notify.releasedCheck': 'assignment',
  'notify.unowned': 'assignment',
  'notify.question': 'question',
  'notify.readCheck': 'question',
  'notify.need': 'decisionApproaching',
  'notify.needGaps': 'assignment',
};

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const date = (value: unknown): value is string => DateTime.safeParse(value).success;

function readIntent(value: unknown, report: Collector): Intent | undefined {
  const key = object(value) && nonempty(value.key) ? value.key : ALL;
  if (
    !object(value) ||
    !nonempty(value.key) ||
    !nonempty(value.toMemberId) ||
    !nonempty(value.kind) ||
    !nonempty(value.titleKey) ||
    !Object.hasOwn(titles, value.titleKey) ||
    !object(value.subject) ||
    !['task', 'request', 'arrangement', 'question', 'reading'].includes(
      String(value.subject.type),
    ) ||
    !nonempty(value.subject.id) ||
    (value.subject.type === 'reading' &&
      (!Number.isSafeInteger(value.subject.seq) || Number(value.subject.seq) <= 0)) ||
    (value.subject.optionId !== undefined && !nonempty(value.subject.optionId)) ||
    (value.subject.requestId !== undefined && !nonempty(value.subject.requestId)) ||
    (value.until !== undefined && !date(value.until)) ||
    (value.actBy !== undefined && !date(value.actBy))
  ) {
    report.violation('notification_invalid', key, '知らせの意図の型が不正。');
    return undefined;
  }
  return value as unknown as Intent;
}

/** 元の時刻と、別の時差表記をした同じ瞬間を区別しない。 */
function sameTime(a: string | undefined, b: string | undefined): boolean {
  return a === undefined || b === undefined ? a === b : toEpochMinutes(a) === toEpochMinutes(b);
}

/** 固定の当番は開始、開始を確かめられない当番は念のためその日の始まりまでに見る。 */
function dutyActionTime(task: Task): string | undefined {
  return task.timing === 'fixed' ||
    task.timing === 'fixedEndEstimated' ||
    (task.timing === 'day' && task.timeUnconfirmed === true)
    ? task.earliestStart
    : undefined;
}

/** 目安の午前0時を過ぎてから届いた時も、その日の終わりまでは確かめられる。 */
function uncertainDutyDayInProgress(task: Task | undefined, now: number): boolean {
  if (
    task?.timing !== 'day' ||
    task.timeUnconfirmed !== true ||
    !task.earliestStart ||
    !task.deadline
  )
    return false;
  const start = toEpochMinutes(task.earliestStart);
  const remaining = toEpochMinutes(task.deadline) - now;
  return start <= now && remaining > 0 && remaining <= 26 * 60;
}

function checkTime(
  intent: Intent,
  until: string | undefined,
  actBy: string | undefined,
  out: Collector,
) {
  if (!sameTime(intent.until, until) || !sameTime(intent.actBy, actBy)) {
    out.violation('notification_deadline_mismatch', intent.key, '知らせの期限が根拠と違う。');
  }
}

/** 説明可能な元と宛先を持つ基本キー。回の番号は送信側で別に扱う。 */
function expectedKey(intent: Intent): string | undefined {
  const { subject, titleKey, toMemberId } = intent;
  let base: string;
  switch (titleKey) {
    case 'notify.cancel':
    case 'notify.check':
      if (subject.type !== 'request') return undefined;
      base = `${titleKey === 'notify.cancel' ? 'cancel' : 'check'}:${subject.id}`;
      break;
    case 'notify.noReply':
      if (subject.type !== 'request' || subject.optionId || subject.requestId) return undefined;
      base = `noReply:${subject.id}`;
      break;
    case 'notify.proposal':
    case 'notify.changed':
    case 'notify.released':
    case 'notify.releasedCheck':
    case 'notify.unowned':
      if (subject.type !== 'task') return undefined;
      base = `${titleKey.slice('notify.'.length)}:${subject.id}`;
      break;
    case 'notify.question':
      if (subject.type !== 'question') return undefined;
      base = `question:${subject.id}`;
      break;
    case 'notify.readCheck':
      if (subject.type !== 'reading' || subject.seq === undefined) return undefined;
      base = `readCheck:${subject.id}:${subject.seq}`;
      break;
    case 'notify.need':
    case 'notify.needGaps':
      if (subject.type !== 'arrangement' || subject.optionId || subject.requestId) return undefined;
      base = `${titleKey === 'notify.need' ? 'needWays' : 'needGaps'}:${subject.id}`;
      break;
    case 'notify.decide':
    case 'notify.backup':
      if (subject.type !== 'arrangement' || !subject.optionId) return undefined;
      base = `${titleKey === 'notify.decide' ? 'decide' : 'backup'}:${subject.id}:${subject.optionId}`;
      break;
  }
  return `${base}:${toMemberId}`;
}

function activeTask(
  task: Task,
  plan: Plan,
  timeZone: string,
  needShapes: ReadonlyMap<string, 'by' | 'window'>,
  needRequestCurrent: ReadonlyMap<string, boolean>,
): boolean {
  const { arrangementKey, optionKey } = task.basis;
  if (arrangementKey === undefined || optionKey === undefined) return true;
  const arrangement = plan.arrangements.find((a) => a.key === arrangementKey);
  if (!arrangement?.live) return false;
  if (task.extra && arrangement.inUseOptionKey !== optionKey) return false;
  if (arrangement.chosenOptionKey === optionKey) return true;
  if (arrangement.backupOptionKeys.includes(optionKey)) {
    const primary = arrangement.chosenOptionKey;
    const primaryRequests = plan.requests.filter(
      (r) =>
        r.live &&
        r.state !== 'cancelled' &&
        r.basis.arrangementKey === arrangement.key &&
        r.basis.optionKey === primary,
    );
    const current = primaryRequests.filter(
      (r) =>
        matchesArrangementDay(r.window, arrangement, timeZone, needShapes.get(arrangement.key)) ===
        true,
    );
    const unknownWindow = primaryRequests.some(
      (r) =>
        ['confirmed', 'awaitingReply', 'turnedDown'].includes(r.state) &&
        matchesArrangementDay(r.window, arrangement, timeZone, needShapes.get(arrangement.key)) ===
          undefined,
    );
    const primaryConfirmed =
      primary !== undefined &&
      !unknownWindow &&
      arrangement.inUseOptionKey === primary &&
      current.some(
        (r) =>
          r.state === 'confirmed' &&
          (arrangement.kind !== 'need' || needRequestCurrent.get(r.requestId) === true),
      ) &&
      !current.some(
        (r) =>
          r.state === 'awaitingReply' ||
          r.needsCheck ||
          ((arrangement.kind === 'childCare' ||
            (arrangement.kind === 'need' && needShapes.get(arrangement.key) === 'window')) &&
            matchesArrangementWindow(r.window, arrangement) === false),
      );
    return arrangement.inUseOptionKey === optionKey || !primaryConfirmed;
  }
  return (
    arrangement.kind === 'purchase' &&
    arrangement.status === 'decidable' &&
    arrangement.recommendedOptionKey === optionKey
  );
}

/** 選択・問いは近づいてから。自分への提案と、遠い仕組みの提案は知らせない。 */
function checkTiming(
  intent: Intent,
  plan: Plan,
  events: readonly DomainEvent[],
  out: Collector,
): void {
  const now = toEpochMinutes(plan.now);
  if (intent.titleKey === 'notify.readCheck' && intent.subject.type === 'reading') {
    const reading = events.find(
      (event) =>
        event.seq === intent.subject.seq &&
        event.type === 'modelOutputRecorded' &&
        event.call === 'extract',
    );
    if (reading && now < toEpochMinutes(reading.occurredAt) + 60)
      out.violation('notification_wrong_time', intent.key, '読み取りから一時間たっていない。');
    return;
  }
  const inWindow = (deadline: string | undefined) => {
    if (!deadline) return false;
    const remaining = toEpochMinutes(deadline) - now;
    return remaining > 0 && remaining <= 26 * 60;
  };
  const subjectTask =
    intent.subject.type === 'task'
      ? plan.tasks.find((entry) => entry.key === intent.subject.id)
      : undefined;
  // 不要になった引き受けは、始まる前の 26 時間以内に知らせる。すでに始まっていても、
  // 終わるまではまだ家族が動いている可能性がある。時刻の無い物は本人が確認するまで。
  if (intent.titleKey === 'notify.released' || intent.titleKey === 'notify.releasedCheck') {
    const by = intent.actBy ?? intent.until;
    if (by && toEpochMinutes(by) > now && !inWindow(by))
      out.violation('notification_wrong_time', intent.key, '知らせる時機ではない。');
    return;
  }
  if (
    [
      'notify.decide',
      'notify.backup',
      'notify.noReply',
      'notify.question',
      'notify.unowned',
    ].includes(intent.titleKey) &&
    !inWindow(
      intent.titleKey === 'notify.unowned' ? (intent.actBy ?? intent.until) : intent.until,
    ) &&
    !(intent.titleKey === 'notify.unowned' && uncertainDutyDayInProgress(subjectTask, now))
  ) {
    out.violation('notification_wrong_time', intent.key, '知らせる時機ではない。');
  }
  if (intent.titleKey !== 'notify.proposal' || intent.subject.type !== 'task') return;
  const task = subjectTask;
  if (!task) return; // 元の作業が無いことは checkSubject が報告する。
  const proposed = events.findLast(
    (event) => event.type === 'assignmentProposed' && event.taskKey === task.key,
  );
  if (proposed?.actorId === intent.toMemberId) {
    out.violation('notification_self_proposal', intent.key, '自分自身への提案を知らせている。');
  } else if (proposed === undefined || proposed.actorId === 'system') {
    const arrangement = plan.arrangements.find((entry) => entry.key === task.basis.arrangementKey);
    const option = arrangement?.options.find((entry) => entry.key === task.basis.optionKey);
    if (
      !inWindow(option?.decisionDeadline ?? dutyActionTime(task) ?? task.deadline ?? task.start) &&
      !uncertainDutyDayInProgress(task, now)
    ) {
      out.violation('notification_wrong_time', intent.key, '仕組みの提案を早く知らせている。');
    }
  }
}

/** 選んだ案を使っておらず、別の案を選べる状態。推薦の有無とは別に確かめる。 */
function choiceNeededAgain(arrangement: Arrangement): boolean {
  return (
    arrangement.live &&
    arrangement.status === 'decidable' &&
    arrangement.chosenOptionKey !== undefined &&
    arrangement.inUseOptionKey === undefined
  );
}

/** 画面と通知の関数を呼ばず、手配の欄から次に決める事を照らす。 */
function needDecision(
  arrangement: Arrangement,
  household: Family,
): 'ways' | 'stuck' | 'choose' | 'gaps' | 'settled' {
  const missing = arrangement.reasons.find((reason) => reason.code === 'inputMissing');
  if (missing?.refs.includes('waysChanged')) return 'ways';
  if (arrangement.reasons.some((reason) => reason.code === 'noSlot')) return 'stuck';
  if (arrangement.status === 'undetermined') return 'ways';
  if (
    arrangement.status === 'infeasible' ||
    arrangement.reasons.some((r) => r.code === 'noOptionLeft')
  )
    return 'stuck';
  if (arrangement.chosenOptionKey === undefined || choiceNeededAgain(arrangement)) {
    const canChoose = arrangement.options.some(
      (option) =>
        !option.expired &&
        (!household.stoppedWayIds?.includes(option.templateId) ||
          arrangement.chosenOptionKey === option.key ||
          arrangement.backupOptionKeys.includes(option.key)),
    );
    if (
      !canChoose &&
      arrangement.options.some((option) => household.stoppedWayIds?.includes(option.templateId))
    )
      return 'ways';
    return 'choose';
  }
  return arrangement.reasons.some((reason) => reason.code === 'notCovered') ? 'gaps' : 'settled';
}

/** 通知に使う「すること」の形と日時を、計画の印ではなく家族の言明・確認から照らす。 */
function notificationNeedShape(
  arrangement: Arrangement,
  plan: Plan,
  facts: FactState | undefined,
  timeZone: string,
  key: string,
  out: Collector,
  windows: NeedWindows,
): { valid: boolean; shape: 'by' | 'window' | undefined } {
  const requirement = plan.requirements.find((entry) => entry.key === arrangement.requirementKey);
  if (!requirement?.live || requirement.kind !== 'need' || requirement.unconfirmed)
    return { valid: false, shape: undefined };
  const id = requirement.basis.itemIds.length === 1 ? requirement.basis.itemIds[0] : undefined;
  const item = timedNeedItem(id === undefined ? undefined : facts?.items.get(id), windows);
  const confirmation = id === undefined ? undefined : facts?.needConfirmation.get(id);
  if (
    confirmation === 'pending' ||
    confirmation === 'dismissed' ||
    (id && facts?.active.get(id) === false)
  )
    return { valid: false, shape: undefined };
  if (
    item?.kind !== 'need' ||
    !item.interpretation.shape ||
    (confirmation !== 'stated' && confirmation !== 'confirmed') ||
    (id !== undefined && facts?.staleItems.has(id))
  ) {
    out.undetermined(
      'notification_need_evidence_unverified',
      key,
      'することの形と日時の根拠を確かめられない。',
    );
    return { valid: true, shape: arrangement.needShape };
  }
  const shape = item.interpretation.shape;
  if (arrangement.needShape !== undefined && arrangement.needShape !== shape) {
    out.violation('notification_need_shape_mismatch', key, '手配の形が元の事項と違う。');
  }
  if (shape === 'window') {
    const window = statedWindow(item);
    if (!window) {
      out.undetermined('notification_need_evidence_unverified', key, '窓の日時を確かめられない。');
    } else if (
      toEpochMinutes(arrangement.start) !== window.start ||
      toEpochMinutes(arrangement.end) !== window.end
    ) {
      out.violation('notification_need_frame_mismatch', key, '知らせの手配の窓が元の事項と違う。');
    }
  } else {
    const deadline = needDeadline(item, timeZone);
    const end = toEpochMinutes(arrangement.end);
    if (deadline === undefined) {
      out.undetermined('notification_need_evidence_unverified', key, '締切を確かめられない。');
    } else if (end !== deadline && !(item.interpretation.deadlineDayOnly && end === deadline + 1)) {
      out.violation(
        'notification_need_frame_mismatch',
        key,
        '知らせの手配の締切が元の事項と違う。',
      );
    }
  }
  return { valid: true, shape };
}

/**
 * 子の居場所の手配に、確保できた予備があるか：予備の案の作業（足した物を除く）が全部済み、外の相手に頼む作業は、
 * その日の分の確かめの要らない「はい」がある。日の分からない頼み事は確保と数えない。
 */
function backupSecured(plan: Plan, arrangement: Arrangement, timeZone: string): boolean {
  return arrangement.backupOptionKeys.some((key) => {
    const option = arrangement.options.find((o) => o.key === key);
    const steps = (option?.taskKeys ?? [])
      .map((taskKey) => plan.tasks.find((t) => t.key === taskKey))
      .filter((t): t is Task => t !== undefined && !t.extra);
    return (
      steps.length > 0 &&
      steps.every(
        (t) =>
          t.live &&
          t.commitment === 'done' &&
          (t.external === undefined ||
            plan.requests.some(
              (r) =>
                r.taskKey === t.key &&
                r.live &&
                r.needsCheck !== true &&
                r.state === 'confirmed' &&
                matchesArrangementDay(r.window, arrangement, timeZone) === true,
            )),
      )
    );
  });
}

/**
 * 返事を待つ手配で、まだ押さえていない次の手の一番早い決め時が 26 時間以内か（その間は、予備を押さえるかの札が
 * 同じ返事を追う）。「すること」で家族がやめたやり方の案は、次の手に数えない（新しくは選べない）。
 */
function backupDue(plan: Plan, arrangement: Arrangement, household: Family): boolean {
  if (arrangement.status !== 'dependsOnReply') return false;
  const deadlines = arrangement.options
    .filter(
      (o) =>
        !o.expired &&
        o.decisionDeadline !== undefined &&
        o.key !== arrangement.chosenOptionKey &&
        !arrangement.backupOptionKeys.includes(o.key) &&
        !(arrangement.kind === 'need' && household.stoppedWayIds?.includes(o.templateId)),
    )
    .map((o) => toEpochMinutes(o.decisionDeadline as string));
  if (deadlines.length === 0) return false;
  const left = Math.min(...deadlines) - toEpochMinutes(plan.now);
  return left > 0 && left <= 26 * 60;
}

/** 出典のある札が、その人の今の計画に本当にあるかを、知らせの生成関数を使わずに照らす。 */
function checkSubject(
  intent: Intent,
  plan: Plan,
  household: Family,
  timeZone: string,
  needShapes: ReadonlyMap<string, 'by' | 'window'>,
  needRequestCurrent: ReadonlyMap<string, boolean>,
  events: readonly DomainEvent[],
  facts: FactState | undefined,
  out: Collector,
  windows: NeedWindows,
): undefined {
  const { subject, titleKey, toMemberId: member } = intent;
  const wrong = (): undefined => {
    out.violation('notification_subject_mismatch', intent.key, 'この人に出す根拠が計画にない。');
    return undefined;
  };
  if (titleKey === 'notify.readCheck') {
    if (subject.type !== 'reading' || subject.seq === undefined || !facts) return wrong();
    const received = events.findLast(
      (event) => event.type === 'noticeReceived' && event.source.id === subject.id,
    );
    const reading = events.find(
      (event) =>
        event.seq === subject.seq &&
        event.type === 'modelOutputRecorded' &&
        event.call === 'extract',
    );
    if (
      !received ||
      received.actorId === 'system' ||
      received.actorId !== member ||
      !reading ||
      facts.sourceReadingSeq.get(subject.id) !== subject.seq ||
      ![...facts.items.values()].some(
        (item) =>
          item.sourceId === subject.id &&
          item.kind === 'need' &&
          facts.needConfirmation.get(item.id) === 'pending' &&
          facts.active.get(item.id) !== false &&
          plan.requirements.some(
            (requirement) =>
              requirement.kind === 'need' &&
              requirement.unconfirmed === true &&
              requirement.basis.itemIds.includes(item.id),
          ),
      )
    )
      return wrong();
    checkTime(intent, undefined, undefined, out);
    return;
  }
  if (titleKey === 'notify.released' || titleKey === 'notify.releasedCheck') {
    if (subject.type !== 'task') return wrong();
    const release = plan.released?.find(
      (entry) => entry.taskKey === subject.id && entry.assigneeId === member,
    );
    if (!release) return wrong();
    if ((release.reason === 'unconfirmed') !== (titleKey === 'notify.releasedCheck'))
      return wrong();
    const until = release.end ?? release.start;
    checkTime(intent, until, sameTime(release.start, until) ? undefined : release.start, out);
    return;
  }
  if (titleKey === 'notify.cancel' || titleKey === 'notify.check') {
    if (subject.type !== 'request') return wrong();
    const request = plan.requests.find((r) => r.requestId === subject.id);
    if (!request || request.sentBy !== member) return wrong();
    if (titleKey === 'notify.check') {
      if (!request.needsCheck || !['awaitingReply', 'confirmed'].includes(request.state))
        return wrong();
    } else if (
      request.live ||
      request.needsCheck === true ||
      !['awaitingReply', 'confirmed'].includes(request.state) ||
      !plan.tasks.some(
        (task) =>
          task.live &&
          task.cancels === request.requestId &&
          task.assigneeId === member &&
          task.commitment !== 'done' &&
          task.commitment !== 'declined',
      )
    )
      return wrong();
    checkTime(intent, request.window?.end, request.window?.start, out);
    return;
  }
  if (titleKey === 'notify.noReply') {
    if (subject.type !== 'request' || subject.optionId || subject.requestId) return wrong();
    const request = plan.requests.find((r) => r.requestId === subject.id);
    if (
      !request?.live ||
      request.needsCheck === true ||
      request.state !== 'awaitingReply' ||
      request.sentBy !== member ||
      !request.window
    )
      return wrong();
    const arrangement = plan.arrangements.find((a) => a.key === request.basis.arrangementKey);
    // 子の居場所と、窓の「すること」だけ（締切の形は、返事の期限を決めていないので知らせない）。「すること」は、
    // 送った時の中身とやり方が今も同じと、事象から確かめられる頼み事だけ。確保できた予備で追うのをやめるのは、
    // 子の居場所だけ（「すること」の窓の受け持ちは別に数え、予備が済んでも確保とは言わない）。
    const shape = arrangement?.kind === 'need' ? needShapes.get(arrangement.key) : undefined;
    if (
      !arrangement?.live ||
      !(
        arrangement.kind === 'childCare' ||
        (arrangement.kind === 'need' &&
          shape === 'window' &&
          needRequestCurrent.get(request.requestId) === true)
      ) ||
      arrangement.status !== 'dependsOnReply' ||
      request.basis.optionKey === undefined ||
      arrangement.inUseOptionKey !== request.basis.optionKey ||
      matchesArrangementDay(request.window, arrangement, timeZone, shape) !== true ||
      (arrangement.kind === 'childCare' && backupSecured(plan, arrangement, timeZone)) ||
      backupDue(plan, arrangement, household)
    )
      return wrong();
    checkTime(intent, request.window.start, undefined, out);
    // 上げ始める時（窓の始まりの 26 時間前）以降に送った頼み事は、送った本人が動いたばかりなので知らせない。
    if (toEpochMinutes(request.sentAt) >= toEpochMinutes(request.window.start) - 26 * 60)
      out.violation(
        'notification_wrong_time',
        intent.key,
        '遅く頼んだ頼み事の返事を知らせている。',
      );
    return;
  }
  if (titleKey === 'notify.proposal' || titleKey === 'notify.changed') {
    if (subject.type !== 'task') return wrong();
    const task = plan.tasks.find((t) => t.key === subject.id);
    if (
      !task?.live ||
      task.cancels !== undefined ||
      task.assigneeId !== member ||
      !activeTask(task, plan, timeZone, needShapes, needRequestCurrent) ||
      (titleKey === 'notify.proposal'
        ? task.commitment !== 'proposed'
        : task.commitment !== 'accepted' || !task.reconfirm)
    )
      return wrong();
    const until = task.start ?? task.deadline;
    const actBy = task.start ?? dutyActionTime(task);
    checkTime(intent, until, sameTime(actBy, until) ? undefined : actBy, out);
    return;
  }
  if (titleKey === 'notify.unowned') {
    if (subject.type !== 'task') return wrong();
    const task = plan.tasks.find((entry) => entry.key === subject.id);
    if (
      !task?.live ||
      task.cancels !== undefined ||
      ['done', 'cancelled'].includes(task.commitment) ||
      (task.assigneeId !== undefined && !['declined', 'withdrawn'].includes(task.commitment)) ||
      !activeTask(task, plan, timeZone, needShapes, needRequestCurrent)
    )
      return wrong();
    const arrangement = plan.arrangements.find((entry) => entry.key === task.basis.arrangementKey);
    const requirementKeys = [task.basis.requirementKey, arrangement?.requirementKey].filter(
      (key): key is string => key !== undefined,
    );
    if (
      plan.questions.some(
        (question) =>
          question.family !== undefined &&
          question.affects.some((key) => requirementKeys.includes(key)),
      )
    ) {
      out.violation(
        'notification_family_unanswered',
        intent.key,
        '家族の答えで変わる作業を、先に担当なしとして知らせている。',
      );
      return;
    }
    const option = arrangement?.options.find((entry) => entry.key === task.basis.optionKey);
    const sent = plan.requests.filter(
      (entry) => entry.basis.optionKey === option?.key && entry.state !== 'cancelled',
    );
    const started =
      option !== undefined &&
      arrangement !== undefined &&
      (plan.tasks.some(
        (entry) => entry.basis.optionKey === option.key && entry.commitment === 'done',
      ) ||
        sent.some(
          (entry) =>
            matchesArrangementDay(
              entry.window,
              arrangement,
              timeZone,
              needShapes.get(arrangement.key),
            ) === true &&
            (arrangement.kind !== 'need' || needRequestCurrent.get(entry.requestId) === true),
        ));
    if (option?.expired && !started) {
      if (
        !arrangement ||
        !sent.some(
          (entry) =>
            matchesArrangementDay(
              entry.window,
              arrangement,
              timeZone,
              needShapes.get(arrangement.key),
            ) === undefined ||
            (arrangement.kind === 'need' && needRequestCurrent.get(entry.requestId) === undefined),
        )
      )
        return wrong();
      out.undetermined(
        'notification_started_unverified',
        intent.key,
        '以前の依頼の日が分からず、今の案を始めたか確かめられない。',
      );
    }
    const deadline =
      option && !option.expired && option.decisionDeadline
        ? option.decisionDeadline
        : task.deadline;
    checkTime(intent, deadline, option ? undefined : dutyActionTime(task), out);
    return;
  }
  if (titleKey === 'notify.question') {
    if (subject.type !== 'question') return wrong();
    const question = plan.questions.find(
      (q) => q.unknownId === subject.id && (q.toMemberId === undefined || q.toMemberId === member),
    );
    if (!question) return wrong();
    if (!question.family) {
      const requirementKeys = plan.arrangements
        .filter((entry) => question.affects.includes(entry.key))
        .map((entry) => entry.requirementKey);
      if (
        plan.questions.some(
          (entry) => entry.family && entry.affects.some((key) => requirementKeys.includes(key)),
        )
      ) {
        out.violation(
          'notification_family_unanswered',
          intent.key,
          '家族の答えで変わる持ち物を、先に家にあるか聞いている。',
        );
        return;
      }
    }
    const deadline = question.family ? question.until : question.askBy;
    if (deadline === undefined) return wrong();
    checkTime(intent, deadline, undefined, out);
    return;
  }
  if (titleKey === 'notify.need' || titleKey === 'notify.needGaps') {
    if (subject.type !== 'arrangement' || subject.optionId || subject.requestId) return wrong();
    const arrangement = plan.arrangements.find((entry) => entry.key === subject.id);
    if (!arrangement?.live || arrangement.kind !== 'need' || arrangement.status === 'askFirst')
      return wrong();
    const inUse = arrangement.inUseOptionKey;
    const waiting = plan.requests.some(
      (request) =>
        request.live &&
        request.basis.optionKey === inUse &&
        (request.state === 'awaitingReply' || request.needsCheck === true),
    );
    const unfinished = plan.tasks.some(
      (task) =>
        task.live &&
        task.cancels === undefined &&
        task.basis.optionKey === inUse &&
        activeTask(task, plan, timeZone, needShapes, needRequestCurrent) &&
        task.commitment !== 'done' &&
        !(
          task.cover === true &&
          task.commitment === 'accepted' &&
          !task.reconfirm &&
          task.start !== undefined
        ),
    );
    const hasCard =
      arrangement.status === 'undetermined' ||
      arrangement.status === 'infeasible' ||
      arrangement.reasons.some((reason) => reason.code === 'noOptionLeft') ||
      (arrangement.options.length > 0 && arrangement.chosenOptionKey === undefined) ||
      choiceNeededAgain(arrangement) ||
      (arrangement.reasons.some((reason) => reason.code === 'notCovered') &&
        (arrangement.inUseOptionKey === undefined ||
          toEpochMinutes(arrangement.start) - toEpochMinutes(plan.now) <= 26 * 60 ||
          (!waiting && !unfinished)));
    if (!hasCard) return wrong();
    const decision = needDecision(arrangement, household);
    if (
      (titleKey === 'notify.need' && decision !== 'ways') ||
      (titleKey === 'notify.needGaps' && decision !== 'gaps')
    )
      return wrong();
    const evidence = notificationNeedShape(
      arrangement,
      plan,
      facts,
      timeZone,
      intent.key,
      out,
      windows,
    );
    if (!evidence.valid) return wrong();
    if (titleKey === 'notify.needGaps' && evidence.shape === 'by') return wrong();
    if (evidence.shape === undefined) {
      if (!sameTime(intent.until, arrangement.end))
        out.violation('notification_deadline_mismatch', intent.key, '知らせの期限が根拠と違う。');
      return;
    }
    const actBy = evidence.shape === 'window' ? arrangement.start : undefined;
    checkTime(intent, arrangement.end, actBy, out);
    const now = toEpochMinutes(plan.now);
    const from = toEpochMinutes(actBy ?? arrangement.end);
    if (from - now > 26 * 60 || toEpochMinutes(arrangement.end) <= now)
      out.violation('notification_wrong_time', intent.key, '知らせる時機ではない。');
    return;
  }
  if (subject.type !== 'arrangement' || !subject.optionId) return wrong();
  const arrangement = plan.arrangements.find((a) => a.key === subject.id);
  const option = arrangement?.options.find((o) => o.key === subject.optionId);
  if (!arrangement?.live || !option?.decisionDeadline || option.expired) return wrong();
  const optionDeadline = option.decisionDeadline;
  const selectable = (candidate: Arrangement['options'][number]) =>
    arrangement.kind !== 'need' ||
    !household.stoppedWayIds?.includes(candidate.templateId) ||
    arrangement.chosenOptionKey === candidate.key ||
    arrangement.backupOptionKeys.includes(candidate.key);
  if (!selectable(option)) return wrong();
  if (titleKey === 'notify.backup') {
    const request = plan.requests.find((r) => r.requestId === subject.requestId);
    if (
      arrangement.status !== 'dependsOnReply' ||
      !request?.live ||
      request.needsCheck ||
      request.state !== 'awaitingReply' ||
      request.sentBy !== member ||
      request.basis.arrangementKey !== arrangement.key ||
      arrangement.chosenOptionKey === option.key ||
      arrangement.backupOptionKeys.includes(option.key)
    )
      return wrong();
  } else {
    if (arrangement.kind === 'need') {
      if (
        subject.requestId ||
        arrangement.status === 'askFirst' ||
        toEpochMinutes(arrangement.end) <= toEpochMinutes(plan.now) ||
        needDecision(arrangement, household) !== 'choose'
      )
        return wrong();
      const evidence = notificationNeedShape(
        arrangement,
        plan,
        facts,
        timeZone,
        intent.key,
        out,
        windows,
      );
      if (!evidence.valid) return wrong();
    } else if (
      arrangement.kind !== 'childCare' ||
      ['askFirst', 'dependsOnReply', 'infeasible'].includes(arrangement.status) ||
      (arrangement.chosenOptionKey !== undefined && !choiceNeededAgain(arrangement))
    )
      return wrong();
    if (arrangement.chosenOptionKey === option.key) return wrong();
  }
  const eligible = arrangement.options.filter((candidate) => {
    if (candidate.expired || !candidate.decisionDeadline) return false;
    if (candidate.key === arrangement.chosenOptionKey) return false;
    if (!selectable(candidate)) return false;
    return titleKey !== 'notify.backup' || !arrangement.backupOptionKeys.includes(candidate.key);
  });
  if (
    eligible.some(
      (candidate) =>
        candidate.decisionDeadline !== undefined &&
        toEpochMinutes(candidate.decisionDeadline) < toEpochMinutes(optionDeadline),
    )
  )
    return wrong();
  checkTime(intent, option.decisionDeadline, undefined, out);
}

/** 家庭が書いた名前の直接一致は見つけられるが、個人情報の全てを検出する保証ではない。 */
function keyHasPersonalText(key: string, household: Family): boolean {
  const normalized = key.normalize('NFKC').toLocaleLowerCase('en');
  const names = [
    ...household.members.flatMap((m) => [m.name, m.addressAs]),
    ...household.places.map((p) => p.name),
  ];
  return names.some((value) => {
    const name = value?.trim().normalize('NFKC').toLocaleLowerCase('en');
    if (!name) return false;
    if (!/^[a-z0-9 ]+$/.test(name)) return normalized.includes(name);
    // 英字名は他の英単語の一部にもなり得る（例：Ann と planning）。独立した語だけを拾う。
    let from = 0;
    for (;;) {
      const index = normalized.indexOf(name, from);
      if (index < 0) return false;
      const before = normalized[index - 1] ?? '';
      const after = normalized[index + name.length] ?? '';
      if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
      from = index + 1;
    }
  });
}

export interface NotificationVerificationInput {
  household: unknown;
  plan: unknown;
  events: unknown;
  intents: unknown;
}

export function verifyNotifications(input: NotificationVerificationInput): VerificationReport {
  const out = new Collector();
  const household = Household.safeParse(input.household);
  const plan = PlanResult.safeParse(input.plan);
  if (!household.success) out.violation('notification_household_invalid', ALL, '家庭の型が不正。');
  if (!plan.success) out.violation('notification_plan_invalid', ALL, '計画の型が不正。');
  if (!Array.isArray(input.events))
    out.violation('notification_events_invalid', ALL, '事象の列ではない。');
  if (!Array.isArray(input.intents))
    out.violation('notification_list_invalid', ALL, '意図の列ではない。');
  if (
    !household.success ||
    !plan.success ||
    !Array.isArray(input.events) ||
    !Array.isArray(input.intents)
  )
    return out.result();
  if (household.data.id !== plan.data.householdId)
    out.violation('notification_household_mismatch', ALL, '家庭と計画が違う。');
  let lastSeq = 0;
  const eventIds = new Set<string>();
  const events: DomainEvent[] = [];
  for (const value of input.events) {
    const event = DomainEvent.safeParse(value);
    if (
      !event.success ||
      event.data.householdId !== household.data.id ||
      event.data.seq !== lastSeq + 1 ||
      eventIds.has(event.data.id)
    ) {
      out.violation('notification_events_invalid', ALL, '家庭の事象の型または順番が不正。');
      break;
    }
    eventIds.add(event.data.id);
    events.push(event.data);
    lastSeq = event.data.seq;
  }
  if (lastSeq !== plan.data.throughSeq)
    out.violation('notification_plan_stale', ALL, '計画と事象の時点が違う。');
  if (out.issues.some((issue) => issue.kind === 'violation')) return out.result();
  const needHistory = plan.data.arrangements.some((entry) => entry.kind === 'need')
    ? checkHistory(household.data, plan.data, events, new Collector())
    : undefined;
  const needShapes = needHistory?.needShapes ?? new Map<string, 'by' | 'window'>();
  const needRequestCurrent = needHistory?.needRequestCurrent ?? new Map<string, boolean>();
  // 計画の reading 旗を根拠にせず、採用された読み取りと家族の言明を事象から組み立てる。
  const readingFacts = input.intents.some(
    (value) =>
      object(value) &&
      ['notify.readCheck', 'notify.need', 'notify.needGaps', 'notify.decide'].includes(
        String(value.titleKey),
      ),
  )
    ? collectFacts(events, new Collector())
    : undefined;
  const whenCheck = new Collector();
  const checkedWindows =
    needHistory && readingFacts
      ? checkNeedWhen(household.data, plan.data, readingFacts, needHistory, whenCheck)
      : new Map();
  const windows = needWindows(events, plan.data, checkedWindows);
  const keys = new Set<string>();
  const now = toEpochMinutes(plan.data.now);
  for (const value of input.intents) {
    const intent = readIntent(value, out);
    if (!intent) continue;
    if (keys.has(intent.key))
      out.violation('notification_duplicate_key', intent.key, '同じキーが重複。');
    keys.add(intent.key);
    const member = household.data.members.find((m) => m.id === intent.toMemberId);
    if (member?.kind !== 'adult' || !member.active)
      out.violation('notification_recipient_invalid', intent.key, '受け手が有効な大人ではない。');
    if (intent.kind !== titles[intent.titleKey])
      out.violation('notification_kind_mismatch', intent.key, '知らせの種類と文が違う。');
    const expected = expectedKey(intent);
    if (expected !== undefined && intent.key !== expected)
      out.violation('notification_key_mismatch', intent.key, '知らせのキーと根拠・宛先が違う。');
    if (intent.until !== undefined && toEpochMinutes(intent.until) <= now)
      out.violation('notification_expired', intent.key, '期限の過ぎた知らせ。');
    if (keyHasPersonalText(intent.key, household.data))
      out.violation(
        'notification_key_personal_text',
        intent.key,
        'キーに家庭の名前または場所が含まれる。',
      );
    checkSubject(
      intent,
      plan.data,
      household.data,
      household.data.timeZone,
      needShapes,
      needRequestCurrent,
      events,
      readingFacts,
      out,
      windows,
    );
    checkTiming(intent, plan.data, events, out);
    out.undetermined(
      'notification_round_unverified',
      intent.key,
      'この知らせが何回目かは、現在の計画だけでは確かめられない。',
    );
  }
  return out.result();
}

// 配信する文の許可表。生成側とは別に保ち、変更の際はこの表も見直す。
const safeText: Record<'ja' | 'en', Record<Title | 'notify.app' | 'notify.many', string>> = {
  ja: {
    'notify.app': 'まにあう',
    'notify.cancel': 'もう要らない頼み事があります。相手に取り消しを伝えてください。',
    'notify.check': '頼み事が、まだ要るか確かめてください。',
    'notify.backup': '返事を待つ間に、予備の案を押さえるか決める時が近づいています。',
    'notify.noReply': '返事がまだ記録されていない頼み事があります。日が近づいています。',
    'notify.decide': '決めることがあります。決め時が近づいています。',
    'notify.proposal': 'おねがいが届いています。引き受けられるか確かめてください。',
    'notify.changed': '引き受けたことの中身が変わりました。確かめてください。',
    'notify.released': '引き受けたことが、もう要らなくなりました。確かめてください。',
    'notify.releasedCheck':
      '引き受けたことが、今の計画に見つかりません。まだ要るか確かめてください。',
    'notify.unowned': 'まだだれもやると決めていないことがあります。期限が近づいています。',
    'notify.question': '段取りについて、聞きたいことがあります。',
    'notify.readCheck': 'お知らせの読み取りで、まだ確かめていないものがあります。',
    'notify.need': '進め方がまだ決まっていないことがあります。日が近づいています。',
    'notify.needGaps': 'まだ受け持ちを確かめられていない時間があります。',
    'notify.many': '確かめてほしいことが {{count}} 件あります。',
  },
  en: {
    'notify.app': 'Maniau',
    'notify.cancel': 'A request is no longer needed. Please let them know.',
    'notify.check': 'Please check whether a request is still needed.',
    'notify.backup': "While you wait for a reply, it's nearly time to decide on a backup.",
    'notify.noReply': 'A request still has no reply recorded, and its day is coming up.',
    'notify.decide': 'Something needs deciding. The decision deadline is coming up.',
    'notify.proposal': "There's a request for you. Can you take it on?",
    'notify.changed': 'Something you took on has changed. Please check it.',
    'notify.released': 'Something you took on is no longer needed. Please check.',
    'notify.releasedCheck':
      'Something you took on is no longer in the plan. Please check whether it is still needed.',
    'notify.unowned': 'Something still has no one to do it, and its deadline is coming up.',
    'notify.question': "There's a question about your plans.",
    'notify.readCheck': "Part of a notice's reading hasn't been checked yet.",
    'notify.need': 'Something still has no way to proceed chosen, and its date is coming up.',
    'notify.needGaps': 'Some hours still have no one confirmed to cover them.',
    'notify.many': '{{count}} things need your attention.',
  },
};

export interface NotificationMessageVerificationInput {
  message: unknown;
  language: unknown;
  intents: unknown;
}

/** 作成後の実際の文を検査する。件数以外を差し込めない固定文だけを受け付ける。 */
export function verifyNotificationMessage(
  input: NotificationMessageVerificationInput,
): VerificationReport {
  const out = new Collector();
  if (
    !object(input.message) ||
    (input.language !== 'ja' && input.language !== 'en') ||
    !Array.isArray(input.intents) ||
    input.intents.length === 0
  ) {
    out.violation('notification_message_invalid', ALL, '知らせる文または意図の型が不正。');
    return out.result();
  }
  const intents = input.intents.flatMap((value) => {
    const parsed = readIntent(value, out);
    return parsed ? [parsed] : [];
  });
  if (intents.length !== input.intents.length) return out.result();
  if (new Set(intents.map((intent) => intent.toMemberId)).size !== 1) {
    out.violation('notification_message_recipients', ALL, '違う人への知らせをまとめている。');
    return out.result();
  }
  const text = safeText[input.language];
  const titleKey = intents.length === 1 ? intents[0]?.titleKey : 'notify.many';
  if (!titleKey) {
    out.violation('notification_message_invalid', ALL, '知らせる文が定まらない。');
    return out.result();
  }
  const body = text[titleKey].replace(
    '{{count}}',
    new Intl.NumberFormat(input.language).format(intents.length),
  );
  if (
    input.message.title !== text['notify.app'] ||
    input.message.body !== body ||
    input.message.titleKey !== titleKey ||
    input.message.count !== intents.length
  )
    out.violation('notification_message_not_allowed', ALL, '知らせる文が許可した固定文と違う。');
  return out.result();
}
