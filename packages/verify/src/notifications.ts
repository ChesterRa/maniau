// 知らせを送る前に、受け取った意図と、最後に送る固定文を独立に照らす。
// 計画の検証は verifyPlan の責務。ここでは知らせに固有の条件を確かめる。

import type { Household as Family, PlanResult as Plan, Task } from '@maniau/core';
import { DateTime, DomainEvent, Household, PlanResult, toEpochMinutes } from '@maniau/core';
import { Collector, type VerificationReport } from './report';
import { matchesArrangementDay, matchesArrangementWindow } from './time';

const ALL = '$all';
type Title =
  | 'notify.cancel'
  | 'notify.check'
  | 'notify.backup'
  | 'notify.decide'
  | 'notify.proposal'
  | 'notify.changed'
  | 'notify.released'
  | 'notify.releasedCheck'
  | 'notify.unowned'
  | 'notify.question';
type Subject = {
  type: 'task' | 'request' | 'arrangement' | 'question';
  id: string;
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
  'notify.decide': 'decisionApproaching',
  'notify.proposal': 'assignment',
  'notify.changed': 'assignment',
  'notify.released': 'assignment',
  'notify.releasedCheck': 'assignment',
  'notify.unowned': 'assignment',
  'notify.question': 'question',
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
    !['task', 'request', 'arrangement', 'question'].includes(String(value.subject.type)) ||
    !nonempty(value.subject.id) ||
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
    case 'notify.decide':
    case 'notify.backup':
      if (subject.type !== 'arrangement' || !subject.optionId) return undefined;
      base = `${titleKey === 'notify.decide' ? 'decide' : 'backup'}:${subject.id}:${subject.optionId}`;
      break;
  }
  return `${base}:${toMemberId}`;
}

function activeTask(task: Task, plan: Plan, timeZone: string): boolean {
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
      (r) => matchesArrangementDay(r.window, arrangement, timeZone) === true,
    );
    const unknownWindow = primaryRequests.some(
      (r) =>
        ['confirmed', 'awaitingReply', 'turnedDown'].includes(r.state) &&
        matchesArrangementDay(r.window, arrangement, timeZone) === undefined,
    );
    const primaryConfirmed =
      primary !== undefined &&
      !unknownWindow &&
      arrangement.inUseOptionKey === primary &&
      current.some((r) => r.state === 'confirmed') &&
      !current.some(
        (r) =>
          r.state === 'awaitingReply' ||
          r.needsCheck ||
          (arrangement.kind === 'childCare' &&
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
    ['notify.decide', 'notify.backup', 'notify.question', 'notify.unowned'].includes(
      intent.titleKey,
    ) &&
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

/** 出典のある札が、その人の今の計画に本当にあるかを、知らせの生成関数を使わずに照らす。 */
function checkSubject(intent: Intent, plan: Plan, timeZone: string, out: Collector): undefined {
  const { subject, titleKey, toMemberId: member } = intent;
  const wrong = (): undefined => {
    out.violation('notification_subject_mismatch', intent.key, 'この人に出す根拠が計画にない。');
    return undefined;
  };
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
  if (titleKey === 'notify.proposal' || titleKey === 'notify.changed') {
    if (subject.type !== 'task') return wrong();
    const task = plan.tasks.find((t) => t.key === subject.id);
    if (
      !task?.live ||
      task.cancels !== undefined ||
      task.assigneeId !== member ||
      !activeTask(task, plan, timeZone) ||
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
      !activeTask(task, plan, timeZone)
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
        sent.some((entry) => matchesArrangementDay(entry.window, arrangement, timeZone) === true));
    if (option?.expired && !started) {
      if (
        !arrangement ||
        !sent.some(
          (entry) => matchesArrangementDay(entry.window, arrangement, timeZone) === undefined,
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
  if (subject.type !== 'arrangement' || !subject.optionId) return wrong();
  const arrangement = plan.arrangements.find((a) => a.key === subject.id);
  const option = arrangement?.options.find((o) => o.key === subject.optionId);
  if (!arrangement?.live || !option?.decisionDeadline || option.expired) return wrong();
  const optionDeadline = option.decisionDeadline;
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
  } else if (
    arrangement.kind !== 'childCare' ||
    ['askFirst', 'dependsOnReply', 'infeasible'].includes(arrangement.status) ||
    (arrangement.chosenOptionKey !== undefined && arrangement.recommendedOptionKey === undefined) ||
    arrangement.chosenOptionKey === option.key
  )
    return wrong();
  const eligible = arrangement.options.filter((candidate) => {
    if (candidate.expired || !candidate.decisionDeadline) return false;
    if (candidate.key === arrangement.chosenOptionKey) return false;
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
    checkSubject(intent, plan.data, household.data.timeZone, out);
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
    'notify.decide': '決めることがあります。決め時が近づいています。',
    'notify.proposal': 'おねがいが届いています。引き受けられるか確かめてください。',
    'notify.changed': '引き受けたことの中身が変わりました。確かめてください。',
    'notify.released': '引き受けたことが、もう要らなくなりました。確かめてください。',
    'notify.releasedCheck':
      '引き受けたことが、今の計画に見つかりません。まだ要るか確かめてください。',
    'notify.unowned': 'まだだれもやると決めていないことがあります。期限が近づいています。',
    'notify.question': '段取りについて、聞きたいことがあります。',
    'notify.many': '確かめてほしいことが {{count}} 件あります。',
  },
  en: {
    'notify.app': 'Maniau',
    'notify.cancel': 'A request is no longer needed. Please let them know.',
    'notify.check': 'Please check whether a request is still needed.',
    'notify.backup': "While you wait for a reply, it's nearly time to decide on a backup.",
    'notify.decide': 'Something needs deciding. The decision deadline is coming up.',
    'notify.proposal': "There's a request for you. Can you take it on?",
    'notify.changed': 'Something you took on has changed. Please check it.',
    'notify.released': 'Something you took on is no longer needed. Please check.',
    'notify.releasedCheck':
      'Something you took on is no longer in the plan. Please check whether it is still needed.',
    'notify.unowned': 'Something still has no one to do it, and its deadline is coming up.',
    'notify.question': "There's a question about your plans.",
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
