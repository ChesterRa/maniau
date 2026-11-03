// 家の決まりによる送り迎えを、出典・事項・言明と独立に照らす。
import type { Household, Item, PlanResult, Requirement, Task } from '@maniau/core';
import type { FactState } from './facts';
import type { History } from './history';
import type { Collector } from './report';
import { dateFromIndex, dateIndex, instantMinute, localMinute, timeOfDay } from './time';

const ESTIMATE_MINUTES = 30;

/** 事象が完全でない・事項が古い時は、食い違いを確定しない。 */
function mismatch(
  certain: boolean,
  code: string,
  subject: string,
  detail: string,
  report: Collector,
): void {
  if (certain) report.violation(code, subject, detail);
  else report.undetermined(`${code}_unverified`, subject, detail);
}

function oneItem(
  basis: { itemIds: string[] },
  subject: string,
  facts: FactState,
  report: Collector,
): Item | undefined {
  const item = basis.itemIds.length === 1 ? facts.items.get(basis.itemIds[0] ?? '') : undefined;
  if (!item)
    report.undetermined(
      'escort_basis_unverified',
      subject,
      '送り迎えの元の事項を一つに決められない。',
    );
  return item;
}

function oneChild(household: Household) {
  const children = household.members.filter((member) => member.kind === 'child' && member.active);
  const child = children.length === 1 ? children[0] : undefined;
  return child?.clubEscort === undefined ? undefined : child;
}

function certainItem(item: Item, facts: FactState, history: History): boolean {
  return (
    history.complete &&
    !facts.staleItems.has(item.id) &&
    (item.evidence === 'stated' || item.evidence === 'confirmed')
  );
}

type Leg = 'to' | 'from';
type LegTime = { date: string; at: string | undefined; timeUnconfirmed: boolean };

function nextDayWritten(item: Item, facts: FactState): boolean {
  const sentences = facts.sourceSentences.get(item.sourceId);
  const cited = item.sentenceIds.map((id) => sentences?.get(id) ?? '');
  return /翌日|翌朝|翌晩|次の日|次の朝|明朝|next day|following day/i.test(
    [item.written, ...cited].join(' '),
  );
}

/** 終了日を同日にも翌日にも確定できない時、日を置かない。 */
function endDateUnknown(item: Item, facts: FactState): boolean {
  const { startTime, endTime, endTimeUnconfirmed } = item.interpretation;
  if (!endTime) return endTimeUnconfirmed === true;
  if (!startTime) return true;
  const start = timeOfDay(startTime);
  const end = timeOfDay(endTime);
  if (end > start) return nextDayWritten(item, facts);
  return 24 * 60 - start + end > 12 * 60;
}

/** 終了日が明示的に表されていない時、始まりだけから翌日の有無を証明できない場合がある。 */
function endDateUnverified(item: Item, facts: FactState): boolean {
  if (endDateUnknown(item, facts)) return true;
  if (!item.interpretation.endTime) return nextDayWritten(item, facts);
  if (!item.interpretation.startTime) return true;
  // 翌日の短い区間にしか置けない時は、原文に「翌日」があってもその日付を照らせる。
  if (timeOfDay(item.interpretation.endTime) <= timeOfDay(item.interpretation.startTime))
    return false;
  const sentences = facts.sourceSentences.get(item.sourceId);
  const cited = item.sentenceIds.map((id) => sentences?.get(id));
  if (cited.length === 0 || cited.some((text) => text === undefined)) return true;
  return nextDayWritten(item, facts);
}

/** 書かれた行事の時刻を、送り・迎えのそれぞれの日に対応させる。 */
function legTime(item: Item, leg: Leg): LegTime | undefined {
  const { date, startTime, endTime } = item.interpretation;
  if (!date) return undefined;
  let at = leg === 'to' ? startTime : endTime;
  let timeUnconfirmed =
    !at &&
    (leg === 'to'
      ? item.interpretation.startTimeUnconfirmed === true
      : item.interpretation.endTimeUnconfirmed === true);
  let legDate: string = date;
  if (leg === 'from' && at && startTime) {
    const startMinute = timeOfDay(startTime);
    const endMinute = timeOfDay(at);
    if (endMinute <= startMinute) {
      if (24 * 60 - startMinute + endMinute > 12 * 60) {
        at = undefined;
        timeUnconfirmed = true;
      } else legDate = dateFromIndex(dateIndex(date) + 24 * 60);
    }
  }
  return { date: legDate, at, timeUnconfirmed };
}

function currentStatement(item: Item, leg: Leg, time: LegTime, childId: string, facts: FactState) {
  const stated = facts.escorts.get(`${item.id}:${leg}`);
  const what = item.interpretation.what ?? item.written;
  return stated &&
    stated.childId === childId &&
    stated.what === what &&
    stated.date === time.date &&
    stated.at === (time.at ?? null) &&
    stated.place === (item.interpretation.place ?? null)
    ? stated
    : undefined;
}

function checkRequirement(
  requirement: Requirement,
  household: Household,
  facts: FactState,
  history: History,
  report: Collector,
): void {
  if (!requirement.live || requirement.kind !== 'escort') return;
  const item = oneItem(requirement.basis, requirement.key, facts, report);
  if (!item) return;
  const certain = certainItem(item, facts, history);
  if (item.kind !== 'event')
    mismatch(
      certain,
      'escort_item_kind_mismatch',
      requirement.key,
      '送り迎えの元が行事ではない。',
      report,
    );
  const sender = facts.sourceSenders.get(item.sourceId);
  if (sender === undefined)
    report.undetermined(
      'escort_source_unverified',
      requirement.key,
      '行事の送り手を確かめられない。',
    );
  else if (sender !== 'club')
    mismatch(
      certain,
      'escort_source_mismatch',
      requirement.key,
      '習い事・クラブからの行事ではない。',
      report,
    );
  if ((item.interpretation.what ?? item.written) !== requirement.what)
    mismatch(
      certain,
      'escort_requirement_content_mismatch',
      requirement.key,
      '行事と要件の用件が違う。',
      report,
    );
  const date = item.interpretation.date;
  if (date === undefined)
    report.undetermined('escort_date_unverified', requirement.key, '行事の日を確かめられない。');
  else if (date !== requirement.date)
    mismatch(
      certain,
      'escort_requirement_date_mismatch',
      requirement.key,
      '行事と要件の日が違う。',
      report,
    );
  const child = oneChild(household);
  if (!child?.clubEscort) {
    const hasHousehold = history.events.some((event) => event.type === 'householdSet');
    mismatch(
      certain && hasHousehold,
      'escort_child_ambiguous',
      requirement.key,
      '行事の対象となる子と家の決まりを一人に決められない。',
      report,
    );
    return;
  }
  if (!date || household.timeZone !== 'Asia/Tokyo') return;
  if (
    (child.clubEscort.from || facts.escorts.has(`${item.id}:from`)) &&
    endDateUnverified(item, facts)
  ) {
    report.undetermined(
      'escort_end_date_unverified',
      requirement.key,
      '迎えの日を原文から確かめられない。',
    );
    return;
  }
  const moments = (['to', 'from'] as const).flatMap((leg) => {
    const time = legTime(item, leg);
    if (!time) return [];
    const stated = currentStatement(item, leg, time, child.id, facts);
    if (!(stated?.needed ?? child.clubEscort?.[leg])) return [];
    return [dateIndex(time.date) + (time.at ? timeOfDay(time.at) - ESTIMATE_MINUTES : 0)];
  });
  if (moments.length === 0) {
    mismatch(
      certain,
      'escort_requirement_unneeded',
      requirement.key,
      'どちらの送り迎えも要らない。',
      report,
    );
  } else if (
    !requirement.by ||
    localMinute(instantMinute(requirement.by), household.timeZone).localIndex !==
      Math.min(...moments)
  ) {
    mismatch(
      certain,
      'escort_requirement_deadline_mismatch',
      requirement.key,
      '要件の期限が最初の送り迎えの目安と違う。',
      report,
    );
  }
}

function checkTask(
  task: Task,
  requirement: Requirement,
  household: Household,
  facts: FactState,
  history: History,
  report: Collector,
): void {
  if (!task.live || !requirement.live || requirement.kind !== 'escort') return;
  const leg =
    task.titleKey === 'task.escortTo'
      ? 'to'
      : task.titleKey === 'task.escortFrom'
        ? 'from'
        : undefined;
  if (!leg) {
    report.undetermined('escort_leg_unverified', task.key, '送りか迎えか分からない。');
    return;
  }
  const item = oneItem(task.basis, task.key, facts, report);
  const child = oneChild(household);
  if (!item || !child?.clubEscort) return;
  const certain = certainItem(item, facts, history);
  if (requirement.basis.itemIds.length === 1 && requirement.basis.itemIds[0] !== item.id) {
    mismatch(
      certain,
      'escort_task_basis_mismatch',
      task.key,
      '作業と要件が別の行事を指している。',
      report,
    );
  }
  const { place } = item.interpretation;
  const what = item.interpretation.what ?? item.written;
  if (!place)
    report.undetermined('escort_place_unverified', task.key, '行事の場所を確かめられない。');
  if (task.start !== undefined && task.end !== undefined)
    report.undetermined(
      'escort_route_unverified',
      task.key,
      '送り迎えの往復は目安で、道のりを確かめていない。',
    );
  const time = legTime(item, leg);
  if (leg === 'from' && endDateUnknown(item, facts)) {
    const date = item.interpretation.date;
    if (
      task.timing !== 'undated' ||
      task.timeUnconfirmed !== true ||
      task.titleParams.eventDate !== date ||
      task.titleParams.date !== undefined ||
      task.titleParams.at !== undefined ||
      task.start !== undefined ||
      task.end !== undefined ||
      task.earliestStart !== undefined ||
      task.deadline !== undefined
    )
      mismatch(
        certain,
        'escort_date_confidence_mismatch',
        task.key,
        '迎えの日を確かめられないのに、日や時刻を決めている。',
        report,
      );
    if (task.titleParams.what !== what || task.titleParams.place !== place)
      mismatch(
        certain,
        'escort_task_content_mismatch',
        task.key,
        '作業の用件が元の行事と違う。',
        report,
      );
    report.undetermined(
      'escort_end_date_unverified',
      task.key,
      '迎えの日を原文から確かめられない。',
    );
    return;
  }
  if (leg === 'from' && endDateUnverified(item, facts)) {
    if (task.titleParams.what !== what || task.titleParams.place !== place)
      mismatch(
        certain,
        'escort_task_content_mismatch',
        task.key,
        '作業の用件が元の行事と違う。',
        report,
      );
    report.undetermined(
      'escort_end_date_unverified',
      task.key,
      '迎えの日を原文から確かめられない。',
    );
    return;
  }
  if (!time) {
    report.undetermined('escort_time_unverified', task.key, '行事の日を確かめられない。');
    return;
  }
  const { date: legDate, at, timeUnconfirmed } = time;
  if (
    task.titleParams.what !== what ||
    task.titleParams.date !== legDate ||
    task.titleParams.at !== at ||
    task.titleParams.place !== place
  )
    mismatch(
      certain,
      'escort_task_content_mismatch',
      task.key,
      '作業の用件が元の行事と違う。',
      report,
    );

  const stated = currentStatement(item, leg, time, child.id, facts);
  if (stated && !stated.needed)
    mismatch(
      certain,
      'escort_statement_conflict',
      task.key,
      '今回は不要と言った送り迎えが残っている。',
      report,
    );
  else if (!stated && !child.clubEscort[leg])
    mismatch(
      certain,
      'escort_rule_conflict',
      task.key,
      '家の決まりにない送り迎えを作っている。',
      report,
    );

  // 日時は家族の時区の壁時計で照らす。この週に対応する日本に夏時間はない。
  if (household.timeZone !== 'Asia/Tokyo') {
    report.undetermined(
      'escort_timezone_unverified',
      task.key,
      '地域の時区で目安の時間を照らせない。',
    );
    return;
  }
  const local = (value: string | undefined) =>
    value && localMinute(instantMinute(value), household.timeZone).localIndex;
  if (!at) {
    if (timeUnconfirmed && task.timeUnconfirmed !== true)
      mismatch(
        certain,
        'escort_time_confidence_mismatch',
        task.key,
        '確認できない時刻の印がない。',
        report,
      );
    if (
      task.timing !== 'day' ||
      task.start !== undefined ||
      task.end !== undefined ||
      task.durationMin !== 0 ||
      local(task.earliestStart) !== dateIndex(legDate) ||
      local(task.deadline) !== dateIndex(legDate) + 24 * 60
    )
      mismatch(
        certain,
        'escort_unwritten_time_scheduled',
        task.key,
        '書かれた時刻を確認できない作業に、確定した時間を置いている。',
        report,
      );
    return;
  }
  const atLocal = dateIndex(legDate) + timeOfDay(at);
  const start = atLocal - ESTIMATE_MINUTES;
  const end = atLocal + ESTIMATE_MINUTES;
  if (
    task.durationMin !== ESTIMATE_MINUTES * 2 ||
    local(task.earliestStart) !== start ||
    local(task.deadline) !== end ||
    (task.start !== undefined && local(task.start) !== start) ||
    (task.end !== undefined && local(task.end) !== end)
  )
    mismatch(
      certain,
      'escort_window_mismatch',
      task.key,
      '行事に対する送り迎えの目安の区間が違う。',
      report,
    );
}

export function checkEscort(
  household: Household,
  plan: PlanResult,
  facts: FactState,
  history: History,
  report: Collector,
): void {
  const requirements = new Map(plan.requirements.map((entry) => [entry.key, entry]));
  for (const requirement of plan.requirements)
    checkRequirement(requirement, household, facts, history, report);
  for (const task of plan.tasks) {
    const requirement = task.basis.requirementKey && requirements.get(task.basis.requirementKey);
    if (requirement) checkTask(task, requirement, household, facts, history, report);
    else if (
      task.live &&
      (task.titleKey === 'task.escortTo' || task.titleKey === 'task.escortFrom')
    ) {
      mismatch(
        history.complete,
        'escort_requirement_missing',
        task.key,
        '送り迎えの要件をたどれない。',
        report,
      );
    }
  }
}
