import {
  type Arrangement,
  type Basis,
  type CareOptionTemplate,
  type DeadlineRule,
  type Household,
  type Item,
  japaneseHolidayName,
  type OptionPlan,
  type PlanResult,
  type Task,
} from '@maniau/core';
import { dayCoveredAtHome } from './child-care';
import { checkEscort } from './escort';
import { type FactState, historicalItem } from './facts';
import { checkFamilyQuestions } from './family-question';
import { doneContentMatches, type History, otherAnswerPossible, sameBasis } from './history';
import type { NeedWhenWindow } from './need-when';
import { type NeedWindows, needWindows, timedNeedItem } from './need-window';
import { checkNoSlot } from './no-slot';
import type { Collector } from './report';
import {
  dateFromIndex,
  dateIndex,
  instantMinute,
  localMinute,
  matchesArrangementDay,
  timeOfDay,
  weekday,
} from './time';

function indexUnique<T>(
  items: readonly T[],
  key: (item: T) => string,
  kind: string,
  report: Collector,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    const id = key(item);
    if (result.has(id)) report.violation('duplicate_key', id, `${kind}のキーが重複している。`);
    else result.set(id, item);
  }
  return result;
}

/** 家族の否定した当番を、要件や作業として扱っていないか。 */
function checkDutyTurn(
  itemId: string,
  subject: string,
  facts: FactState,
  history: History,
  report: Collector,
): void {
  const item = facts.items.get(itemId);
  const turn = facts.turns.get(itemId);
  if (
    item?.kind !== 'duty' ||
    item.interpretation.familyAction !== true ||
    turn?.ours !== false ||
    turn.what !== (item.interpretation.what ?? item.written) ||
    turn.audience !== (item.interpretation.audience ?? null)
  )
    return;
  // 言った後の事象が欠けていれば、後から「うちの番」と答え直した可能性を除けない。
  if (!history.complete || facts.staleItems.has(itemId) || facts.active.get(itemId) !== true) {
    report.undetermined(
      'duty_turn_unverified',
      subject,
      '当番の帰属の言明が現在も有効か確かめられない。',
    );
  } else {
    report.violation(
      'duty_turn_conflict',
      subject,
      '家族がうちの番ではないと言った当番を、家族の要件や作業にしている。',
    );
  }
}

function checkBasis(
  basis: Basis,
  subject: string,
  live: boolean,
  facts: FactState,
  plan: PlanResult,
  report: Collector,
  exempt: boolean,
  missingReferencesUncertain = false,
  historical = false,
  historicalOption?: true | false | 'unknown',
): void {
  if (!live || exempt) return;
  if (basis.itemIds.length === 0 && !basis.requirementKey && !basis.arrangementKey) {
    report.undetermined('basis_missing', subject, '生きている物の根拠をたどれない。');
  }
  for (const itemId of basis.itemIds) {
    const resolved = historical ? historicalItem(facts, itemId) : undefined;
    const item = facts.items.get(resolved?.itemId ?? itemId);
    const active = resolved?.active ?? facts.active.get(itemId);
    if (!item || active === undefined) {
      report.undetermined('basis_item_missing', subject, '元の事項を事象から確認できない。');
    } else if (active === false) {
      if (historical && missingReferencesUncertain)
        report.undetermined('item_condition_unknown', subject, '依頼の根拠の一部を確認できない。');
      else
        report.violation(
          'inactive_item_basis',
          subject,
          '適用されない元の事項から導いた物が残っている。',
        );
    } else if (active === 'unknown') {
      report.undetermined(
        'item_condition_unknown',
        subject,
        '元の事項の適用または証拠を確認できない。',
      );
    }
  }
  if (basis.requirementKey) {
    const requirement = plan.requirements.find((entry) => entry.key === basis.requirementKey);
    if (!requirement) {
      if (missingReferencesUncertain)
        report.undetermined('requirement_unverified', subject, '根拠の要件を確認できない。');
      else report.violation('requirement_missing', subject, '根拠の要件がない。');
    } else if (!requirement.live) {
      if (missingReferencesUncertain)
        report.undetermined('requirement_unverified', subject, '根拠の要件が必要か確認できない。');
      else
        report.violation(
          'inactive_requirement_basis',
          subject,
          '不要な要件から導いた物が残っている。',
        );
    }
  }
  if (basis.arrangementKey) {
    const arrangement = plan.arrangements.find((entry) => entry.key === basis.arrangementKey);
    if (!arrangement) {
      if (missingReferencesUncertain)
        report.undetermined('arrangement_unverified', subject, '根拠の手配を確認できない。');
      else report.violation('arrangement_missing', subject, '根拠の手配がない。');
    } else if (!arrangement.live) {
      if (missingReferencesUncertain)
        report.undetermined('arrangement_unverified', subject, '根拠の手配が必要か確認できない。');
      else
        report.violation(
          'inactive_arrangement_basis',
          subject,
          '不要な手配から導いた物が残っている。',
        );
    } else if (
      basis.optionKey &&
      !arrangement.options.some((option) => option.key === basis.optionKey)
    ) {
      if (historicalOption === 'unknown')
        report.undetermined('basis_option_unverified', subject, '送った時の案を確かめられない。');
      else if (historicalOption !== true)
        report.violation('basis_option_missing', subject, '根拠の案が手配の中にない。');
    }
  } else if (basis.optionKey) {
    report.undetermined(
      'option_arrangement_missing',
      subject,
      '案の属する手配を根拠からたどれない。',
    );
  }
}

function optionDeadline(
  household: Household,
  arrangement: Arrangement,
  template: CareOptionTemplate,
  report: Collector,
): number | undefined {
  const date = localMinute(instantMinute(arrangement.start), household.timeZone).date;
  return deadlineOnDate(household, date, template.deadline, arrangement.key, report);
}

/** 家族の決まりを、対象日の地域日付から計算する。 */
function deadlineOnDate(
  household: Household,
  date: string,
  rule: DeadlineRule,
  subject: string,
  report: Collector,
): number | undefined {
  let day = dateIndex(date);
  if (rule.type === 'daysBefore') day -= rule.days * 24 * 60;
  else if (rule.type === 'weekdayOfPreviousWeek') {
    day -= (weekday(date) - 1 + 7 - (rule.weekday - 1)) * 24 * 60;
  } else if (rule.type === 'businessDaysBefore') {
    if (rule.days > 730) {
      report.undetermined('deadline_range', subject, '営業日の締切を確認できる範囲を超える。');
      return undefined;
    }
    let left = rule.days;
    while (left > 0) {
      day -= 24 * 60;
      const candidate = dateFromIndex(day);
      const dayOfWeek = weekday(candidate);
      if (dayOfWeek === 6 || dayOfWeek === 7) continue;
      try {
        if (
          japaneseHolidayName(candidate) !== undefined ||
          household.closedDates.includes(candidate)
        )
          continue;
      } catch {
        report.undetermined('holiday_data_missing', subject, '営業日の祝日を確認できない。');
        return undefined;
      }
      left -= 1;
    }
  }
  // 対象の地域は Asia/Tokyo のみであり、この期間に夏時間はない。
  return Date.parse(`${dateFromIndex(day)}T${rule.at}:00+09:00`) / 60_000;
}

/** 手配の形は計画に推測させず、元の事項から確かめる。 */
function needItem(arrangement: Arrangement, plan: PlanResult, facts: FactState): Item | undefined {
  const requirement = plan.requirements.find((entry) => entry.key === arrangement.requirementKey);
  if (requirement?.kind !== 'need' || requirement.basis.itemIds.length !== 1) return undefined;
  const id = requirement.basis.itemIds[0];
  if (!id || facts.active.get(id) !== true || facts.staleItems.has(id)) return undefined;
  const item = facts.items.get(id);
  return item?.kind === 'need' ? item : undefined;
}

export function statedWindow(item: Item | undefined): { start: number; end: number } | undefined {
  const value = item?.interpretation;
  if (
    value?.shape !== 'window' ||
    !value.date ||
    !value.startTime ||
    !value.endTime ||
    value.startTimeUnconfirmed ||
    value.endTimeUnconfirmed
  )
    return undefined;
  const start = Date.parse(`${value.date}T${value.startTime}:00+09:00`) / 60_000;
  const end = Date.parse(`${value.date}T${value.endTime}:00+09:00`) / 60_000;
  return end > start ? { start, end } : undefined;
}

function needDate(item: Item | undefined, timeZone: string): string | undefined {
  const value = item?.interpretation;
  if (value?.shape === 'window') return value.date;
  if (value?.shape === 'by' && value.deadline)
    return localMinute(instantMinute(value.deadline), timeZone).date;
  return undefined;
}

export function needDeadline(item: Item, timeZone: string): number | undefined {
  const value = item.interpretation;
  if (value.shape !== 'by' || !value.deadline) return undefined;
  if (!value.deadlineDayOnly) return instantMinute(value.deadline);
  const date = localMinute(instantMinute(value.deadline), timeZone).date;
  return Date.parse(`${date}T23:59:00+09:00`) / 60_000;
}

/** 決め時が無くても、元の事項と家庭の決まりから、その案の締切が過ぎたと証明できるか。 */
function ruleDeadlinePast(
  option: OptionPlan,
  arrangement: Arrangement,
  household: Household,
  plan: PlanResult,
  facts: FactState,
  history: History,
  report: Collector,
  windows: NeedWindows,
): boolean | 'unknown' {
  if (!history.complete) return 'unknown';
  const requirement = plan.requirements.find((entry) => entry.key === arrangement.requirementKey);
  const id = requirement?.basis.itemIds.length === 1 ? requirement.basis.itemIds[0] : undefined;
  if (!id || facts.staleItems.has(id)) return 'unknown';
  const item = timedNeedItem(facts.items.get(id), windows);
  if (!item) return 'unknown';
  const activity = facts.active.get(id);
  if (activity !== true) {
    // 適用や置換・取消しが未定でも、表示も条件しだいの元の事項なら、その分岐の締切だけは確かめられる。
    // その分岐が実際に適用されるか、変更が効くかは checkBasis が未判定として残す。
    const conditional =
      activity === 'unknown' &&
      requirement?.conditional === true &&
      (item.evidence === 'stated' || item.evidence === 'confirmed');
    if (!conditional) return 'unknown';
  }
  let deadline: number | undefined;
  if (arrangement.kind === 'need' && requirement?.kind === 'need' && item.kind === 'need') {
    if (!['stated', 'confirmed'].includes(facts.needConfirmation.get(id) ?? '')) return 'unknown';
    const way = household.ways.find((entry) => entry.id === option.templateId);
    const date = needDate(item, household.timeZone);
    if (!way || !date) return 'unknown';
    const boundary =
      item.interpretation.shape === 'window'
        ? statedWindow(item)?.start
        : needDeadline(item, household.timeZone);
    if (boundary === undefined) return 'unknown';
    const rule = way.deadline
      ? deadlineOnDate(household, date, way.deadline, option.key, report)
      : undefined;
    // 家庭の決まりを計算できなくても、書かれた窓・締切が過ぎたことは分かる。
    if (way.deadline && rule === undefined && instantMinute(plan.now) <= boundary) return 'unknown';
    deadline = rule === undefined ? boundary : Math.min(boundary, rule);
  } else if (
    arrangement.kind === 'childCare' &&
    requirement?.kind === 'childCare' &&
    item.kind === 'dayChange' &&
    item.interpretation.dayType === 'noSchool' &&
    item.interpretation.date &&
    item.interpretation.date === requirement.date
  ) {
    const care = household.careOptions.find((entry) => entry.id === option.templateId);
    if (!care) return 'unknown';
    deadline = deadlineOnDate(
      household,
      item.interpretation.date,
      care.deadline,
      option.key,
      report,
    );
  }
  return deadline === undefined || !Number.isFinite(deadline)
    ? 'unknown'
    : instantMinute(plan.now) > deadline;
}

function checkStep(
  task: Task,
  household: Household,
  plan: PlanResult,
  facts: FactState,
  report: Collector,
  windows: NeedWindows,
): void {
  if (task.commitment === 'done' && task.end && instantMinute(task.end) < instantMinute(plan.now)) {
    if (task.step)
      report.undetermined(
        'historical_step_unverified',
        task.key,
        '完了時の家庭の決まりと今の決まりが同じか分からない。',
      );
    return;
  }
  if (!task.step) {
    if (task.live && task.basis.optionKey && !task.cancels) {
      report.undetermined('step_missing', task.key, '案の作業を家庭の手順と照らせない。');
    }
    return;
  }
  const arrangement = plan.arrangements.find((entry) => entry.key === task.basis.arrangementKey);
  const careTemplate =
    arrangement?.kind === 'need'
      ? undefined
      : household.careOptions.find((entry) => entry.id === task.step?.templateId);
  const way =
    arrangement?.kind === 'need'
      ? household.ways.find((entry) => entry.id === task.step?.templateId)
      : undefined;
  const template = careTemplate ?? way;
  if (!template) {
    report.violation('step_template_missing', task.key, '元の取れる手がない。');
    return;
  }
  const matches = [...template.steps, ...(careTemplate?.extraSteps ?? [])].filter(
    (step) => step.id === task.step?.stepId,
  );
  if (matches.length !== 1 || !matches[0]) {
    report.violation('step_reference_invalid', task.key, '元の手順がない、または一意でない。');
    return;
  }
  const step = matches[0];
  // 外の相手が受け持つ手順は、窓の前に頼む作業。窓の時刻に置くのは家族自身の受け持ちだけ。
  const cover = way && 'cover' in step && step.cover === true && step.external === undefined;
  if (way && Boolean(task.cover) !== Boolean(cover))
    report.violation('need_cover_marker_mismatch', task.key, '受け持ちの印が家庭の手順と違う。');
  const stated =
    arrangement?.kind === 'need'
      ? timedNeedItem(needItem(arrangement, plan, facts), windows)
      : undefined;
  if (cover) {
    const window = statedWindow(stated);
    if (!window) {
      report.undetermined(
        'need_cover_window_unverified',
        task.key,
        '受け持つ窓を元の事項から確かめられない。',
      );
    } else if (!task.start || !task.end) {
      report.undetermined('need_cover_unscheduled', task.key, '受け持ちの時刻を確認できない。');
    } else if (
      task.durationMin !== window.end - window.start ||
      instantMinute(task.start) !== window.start ||
      instantMinute(task.end) !== window.end
    ) {
      report.violation(
        'need_cover_window_mismatch',
        task.key,
        '受け持ちの作業が元の窓全体と違う。',
      );
    }
  }
  if (
    (!cover && task.durationMin !== step.durationMin) ||
    task.segments.some((segment) => !step.segments.includes(segment))
  ) {
    report.violation(
      'step_constraints_mismatch',
      task.key,
      '所要時間または置いてよい区間が家庭の決まりと違う。',
    );
  }
  if (
    (step.placeId && task.placeId !== step.placeId) ||
    (step.placeKind && task.placeKind !== step.placeKind) ||
    (step.goods && task.goods !== step.goods)
  ) {
    report.violation('step_place_mismatch', task.key, '場所または品物の条件が家庭の決まりと違う。');
  }
  if (
    step.external &&
    (!task.external ||
      task.external.to !== step.external.to ||
      task.external.kind !== step.external.kind)
  ) {
    report.violation('step_external_mismatch', task.key, '外の相手への依頼が家庭の手順と違う。');
  }
  if (step.assigneeId && task.assigneeId !== step.assigneeId) {
    if (task.assigneeId)
      report.violation('step_assignee_mismatch', task.key, '本人が決まった手順の担当が違う。');
    else
      report.undetermined(
        'step_assignee_missing',
        task.key,
        '本人が決まった手順の担当がまだない。',
      );
  }
  const option = arrangement?.options.find((entry) => entry.key === task.basis.optionKey);
  if (option && option.templateId !== template.id)
    report.violation('step_option_mismatch', task.key, '案と作業の取れる手が違う。');

  const extra = careTemplate?.extraSteps.find((entry) => entry.id === step.id);
  if (extra && (!arrangement || !task.start || !task.end)) {
    report.undetermined('extra_step_date_unverified', task.key, '追加の準備の日付を確認できない。');
  } else if (extra && arrangement && task.start && task.end) {
    const start = instantMinute(task.start);
    const end = instantMinute(task.end);
    const target =
      dateIndex(localMinute(instantMinute(arrangement.start), household.timeZone).date) +
      extra.dayOffset * 24 * 60;
    const first = dateIndex(localMinute(start, household.timeZone).date);
    const last = dateIndex(localMinute(Math.max(start, end - 1), household.timeZone).date);
    if (first !== target || last !== target)
      report.violation('extra_step_wrong_date', task.key, '追加の準備の日付が家庭の決まりと違う。');
  }

  // 窓の受け持ちは準備の鎖とは別。予約などの順序だけを確かめる。
  const orderedSteps = way
    ? way.steps.filter((entry) => !entry.cover || entry.external !== undefined)
    : template.steps;
  const stepIndex = orderedSteps.findIndex((entry) => entry.id === step.id);
  if (stepIndex >= 0 && task.live && task.basis.optionKey && task.basis.arrangementKey) {
    // 案の中の連続した手順について、出力の印に頼らず担当を照らす。
    // 前後の担当が違えば、その先も含めて一つの鎖として未配置にする。
    const chain = orderedSteps.map((entry) =>
      plan.tasks.find(
        (candidate) =>
          candidate.live &&
          candidate.basis.optionKey === task.basis.optionKey &&
          candidate.basis.arrangementKey === task.basis.arrangementKey &&
          candidate.step?.templateId === template.id &&
          candidate.step.stepId === entry.id,
      ),
    );
    const differentAssignees = chain.some((current, index) => {
      const previous = chain[index - 1];
      return Boolean(
        current?.assigneeId && previous?.assigneeId && current.assigneeId !== previous.assigneeId,
      );
    });
    const completed = chain.some((entry) => entry?.commitment === 'done');
    if (differentAssignees && completed) {
      // 済んだ作業は実際に受け渡された可能性もあるので、違反ではなく未判定とする。
      report.undetermined(
        'step_handoff_unverified',
        task.key,
        '済んだ手順を含む鎖で、別の担当への受け渡しを確かめられない。',
      );
    } else if (differentAssignees) {
      if (!task.handoff)
        report.violation(
          'step_handoff_unmarked',
          task.key,
          '別の担当への受け渡しが必要な手順に、未確認の印がない。',
        );
      if (task.start || task.end || task.atPlaceId)
        report.violation(
          'step_handoff_scheduled',
          task.key,
          '別の担当が続ける手順に、受け渡しの確認なしで時刻または場所が置かれている。',
        );
    }
  }
  if (stepIndex > 0) {
    const previous = orderedSteps[stepIndex - 1];
    if (previous) {
      const candidates = plan.tasks.filter(
        (entry) =>
          entry.live &&
          entry.basis.optionKey === task.basis.optionKey &&
          entry.step?.templateId === template.id &&
          entry.step.stepId === previous.id,
      );
      if (candidates.length === 0) {
        report.undetermined(
          'step_predecessor_missing',
          task.key,
          '前の手順を計画から確認できない。',
        );
      } else if (candidates.length > 1) {
        report.violation('step_predecessor_duplicate', task.key, '前の手順が複数ある。');
      } else {
        const predecessor = candidates[0];
        const edge = task.after.find((entry) => entry.taskKey === predecessor?.key);
        if (!edge || edge.waitMin < previous.waitAfterMin) {
          report.violation(
            'step_wait_missing',
            task.key,
            '前の手順と必要な待ち時間が含まれていない。',
          );
        }
      }
    }
  }
  if (way && step.deadline && task.end) {
    const date = needDate(stated, household.timeZone);
    if (!date) {
      report.undetermined(
        'step_deadline_unverified',
        task.key,
        '手順の締切の対象日を確かめられない。',
      );
    } else {
      const deadline = deadlineOnDate(household, date, step.deadline, task.key, report);
      if (deadline !== undefined && instantMinute(task.end) > deadline)
        report.violation('step_deadline_missed', task.key, '手順の締切より後に作業が終わる。');
    }
  }
  const lastStep = template.steps.at(-1);
  if (arrangement && option && careTemplate && lastStep?.id === step.id && task.end) {
    const deadline = optionDeadline(household, arrangement, careTemplate, report);
    if (deadline !== undefined && instantMinute(task.end) > deadline) {
      report.violation(
        'template_deadline_missed',
        task.key,
        '家庭の決まりの締切より後に最後の手順が終わる。',
      );
    }
  }
  if (way?.deadline && stepIndex === 0 && task.start) {
    const date = needDate(stated, household.timeZone);
    if (!date) {
      report.undetermined(
        'way_deadline_unverified',
        task.key,
        'やり方の締切の対象日を確かめられない。',
      );
    } else {
      const deadline = deadlineOnDate(household, date, way.deadline, task.key, report);
      if (deadline !== undefined && instantMinute(task.start) > deadline)
        report.violation('way_deadline_missed', task.key, 'やり方の締切より後に手順を始める。');
    }
  }
}

function optionStarted(
  option: OptionPlan,
  arrangement: Arrangement,
  plan: PlanResult,
  history: History,
  timeZone: string,
  byDeadline = false,
): boolean {
  if (
    arrangement.chosenOptionKey !== option.key &&
    !arrangement.backupOptionKeys.includes(option.key)
  )
    return false;
  if (!option.decisionDeadline) return false;
  const choice = history.events
    .filter(
      (entry) =>
        entry.type === 'optionChosen' &&
        entry.arrangementKey === arrangement.key &&
        entry.optionKey === option.key,
    )
    .at(-1);
  if (!choice) return false;
  const deadline = instantMinute(option.decisionDeadline);
  const assignments = new Map<string, string>();
  for (const entry of history.events) {
    if (entry.type === 'assignmentProposed') assignments.set(entry.taskKey, entry.assigneeId);
    if (entry.seq < choice.seq) continue;
    let taskKey: string | undefined;
    if (
      entry.type === 'commitmentChanged' &&
      entry.action === 'done' &&
      entry.actorId === entry.assigneeId &&
      (assignments.get(entry.taskKey) ?? entry.assigneeId) === entry.assigneeId
    ) {
      // 今の状態が本人の「済んだ」でないなら、以前の済みを今の進捗にしない（送信による済みは依頼の日で見る）。
      if (
        history.commitments.get(entry.taskKey) !== 'done' ||
        history.requestBasedDone.has(entry.taskKey)
      )
        continue;
      // 用件が今と違う「済んだ」は、今の案の進捗の証拠にしない。作業が見つからず照らせない時も同様。
      if (entry.content) {
        const current = plan.tasks.find((task) => task.key === entry.taskKey);
        if (!current || !doneContentMatches(current, entry.content)) continue;
      }
      taskKey = entry.taskKey;
    } else if (entry.type === 'externalRequestSent') {
      // 訂正で消えた送信は進捗にしない。控えの日が違う依頼も、現在の日を始めた証拠にはならない。
      // 日の控えが無い古い送信は、現在の日の送信として扱う。独立に確かめられない事は別に示す。
      const sent = history.requests.get(entry.requestId);
      if (!sent || sent.seq !== entry.seq || sent.state === 'cancelled') continue;
      if (arrangement.kind === 'need' && history.needRequestCurrent.get(entry.requestId) === false)
        continue;
      const window = sent.snapshot?.window;
      if (
        matchesArrangementDay(
          window,
          arrangement,
          timeZone,
          history.needShapes.get(arrangement.key),
        ) === false
      )
        continue;
      taskKey = entry.taskKey;
    }
    if (!taskKey || !option.taskKeys.includes(taskKey)) continue;
    if (!byDeadline) return true;
    // 所要時間は計画の目安であり、実際に同じ時間がかかった証拠ではない。
    if (instantMinute(entry.occurredAt) <= deadline) return true;
  }
  return false;
}

/** expired は計画の申告なので、現在時刻と決め時から求め直す。 */
function isPastDecision(option: OptionPlan, plan: PlanResult): boolean | 'unknown' {
  return option.decisionDeadline === undefined
    ? 'unknown'
    : instantMinute(plan.now) > instantMinute(option.decisionDeadline);
}

export function optionFailure(
  option: OptionPlan,
  arrangement: Arrangement,
  plan: PlanResult,
  history: History,
  timeZone: string,
): { code: 'turnedDown' | 'missedDeadline'; refs: string[] } | undefined {
  const requests = [...history.requests.entries()].filter(
    ([, sent]) => option.taskKeys.includes(sent.taskKey) && sent.state !== 'cancelled',
  );
  // 今の日の依頼があればその返事を見る。新しい依頼が一つも無い時は、以前の断りを見落として
  // 使えると決めない（今の日への断りが確定したという意味ではない）。
  const current = requests.filter(
    ([id, sent]) =>
      matchesArrangementDay(
        sent.snapshot?.window,
        arrangement,
        timeZone,
        history.needShapes.get(arrangement.key),
      ) === true &&
      (arrangement.kind !== 'need' || history.needRequestCurrent.get(id) === true),
  );
  // 控えが無い依頼は現在の日の可能性がある。その間、別の日の断りを今も有効と断定しない。
  const unknownDay = requests.some(
    ([id, sent]) =>
      matchesArrangementDay(
        sent.snapshot?.window,
        arrangement,
        timeZone,
        history.needShapes.get(arrangement.key),
      ) === undefined ||
      (arrangement.kind === 'need' && history.needRequestCurrent.get(id) === undefined),
  );
  const turnedDown = (
    current.length > 0 ? current : unknownDay || arrangement.kind === 'need' ? [] : requests
  )
    .filter(([, sent]) => sent.state === 'turnedDown')
    .map(([id]) => id);
  if (turnedDown.length) return { code: 'turnedDown', refs: turnedDown };
  if (
    history.complete &&
    isPastDecision(option, plan) === true &&
    !optionStarted(option, arrangement, plan, history, timeZone)
  )
    return { code: 'missedDeadline', refs: [option.key] };
  return undefined;
}

function checkReasons(
  arrangement: Arrangement,
  plan: PlanResult,
  household: Household,
  facts: FactState,
  history: History,
  report: Collector,
  timeZone: string,
  windows: NeedWindows,
): void {
  if (arrangement.status !== 'decidable' && arrangement.reasons.length === 0) {
    report.violation('reason_missing', arrangement.key, '判断できない理由がない。');
  }
  if (
    arrangement.status === 'dependsOnReply' &&
    !arrangement.reasons.some((reason) => reason.code === 'awaitingReply')
  ) {
    report.violation(
      'waiting_status_without_reason',
      arrangement.key,
      '返事しだいの手配に、返事待ちの理由がない。',
    );
  }
  if (
    arrangement.status === 'askFirst' &&
    !arrangement.reasons.some((reason) => reason.code === 'askFirst')
  ) {
    report.violation(
      'question_status_without_reason',
      arrangement.key,
      '聞いてから決める手配に、問いの理由がない。',
    );
  }
  for (const reason of arrangement.reasons) {
    if (reason.code === 'awaitingReply') {
      if (
        reason.refs.length === 0 ||
        reason.refs.some(
          (id) =>
            !plan.requests.some(
              (request) => request.requestId === id && request.state === 'awaitingReply',
            ),
        )
      ) {
        report.violation(
          'waiting_reason_invalid',
          arrangement.key,
          '返事待ちの理由が実際の依頼を指していない。',
        );
      }
    } else if (reason.code === 'askFirst') {
      if (
        reason.refs.length === 0 ||
        reason.refs.some((key) => !plan.questions.some((question) => question.key === key))
      ) {
        report.violation(
          'question_reason_invalid',
          arrangement.key,
          '問いの理由が実際の問いを指していない。',
        );
      }
    } else if (reason.code === 'noOptionLeft') {
      const options = arrangement.options;
      if (reason.refs.some((key) => !options.some((option) => option.key === key))) {
        report.violation(
          'reason_option_missing',
          arrangement.key,
          '理由が手配にない案を指している。',
        );
      }
      if (
        options.some(
          (option) =>
            isPastDecision(option, plan) !== true ||
            optionStarted(option, arrangement, plan, history, timeZone),
        )
      ) {
        report.undetermined(
          'no_option_left_unverified',
          arrangement.key,
          '期限以外の条件も含め、使える案がないか確かめられない。',
        );
      }
    } else if (reason.code === 'noSlot') {
      if (
        arrangement.status !== 'undetermined' ||
        arrangement.recommendedOptionKey !== undefined ||
        reason.refs.length === 0 ||
        reason.refs.some((key) => {
          const option = arrangement.options.find((entry) => entry.key === key);
          return (
            !option ||
            option.expired ||
            option.deadlineCertainty !== 'undetermined' ||
            option.decisionDeadline !== undefined
          );
        })
      ) {
        report.violation(
          'no_slot_reason_invalid',
          arrangement.key,
          '時刻を決められない案の理由と、実際の案の状態が一致しない。',
        );
      }
      report.undetermined(
        'no_slot_failure_unverified',
        arrangement.key,
        '理由に挙げた案を使えるか、断りなどを含めて確かめきれない。',
      );
    } else if (
      reason.code === 'notCovered' &&
      (arrangement.kind === 'need' || arrangement.kind === 'childCare')
    ) {
      // 窓の「すること」は need-coverage、子の居場所は care-cover が、家庭の記録から独立に照らす。
    } else {
      report.undetermined(
        'reason_not_independently_proved',
        arrangement.key,
        '探索・祝日・入力不足の理由を完全には検証できない。',
      );
    }
  }
  if (arrangement.status === 'infeasible') {
    if (
      arrangement.reasons.some((reason) =>
        ['searchLimit', 'holidayDataMissing', 'inputMissing'].includes(reason.code),
      )
    ) {
      report.violation(
        'infeasible_without_proof',
        arrangement.key,
        '探索の不足や入力不足を、不可能と扱っている。',
      );
    }
    if (
      arrangement.options.some(
        (option) =>
          option.deadlineCertainty === 'undetermined' &&
          isPastDecision(option, plan) !== true &&
          ruleDeadlinePast(
            option,
            arrangement,
            household,
            plan,
            facts,
            history,
            report,
            windows,
          ) !== true &&
          !(
            history.complete &&
            optionFailure(option, arrangement, plan, history, timeZone)?.code === 'turnedDown'
          ),
      )
    ) {
      report.violation(
        'infeasible_with_unknown_option',
        arrangement.key,
        '取れるか未判定の案を残したまま不可能としている。',
      );
    }
    report.undetermined(
      'infeasibility_not_proved',
      arrangement.key,
      'すべての実行可能な案を独立に探索していない。',
    );
  }
}

export function checkPlan(
  household: Household,
  plan: PlanResult,
  facts: FactState,
  history: History,
  report: Collector,
  whenWindows: ReadonlyMap<string, NeedWhenWindow>,
): void {
  const windows = needWindows(history.events, plan, whenWindows);
  const requirements = indexUnique(plan.requirements, (entry) => entry.key, '要件', report);
  indexUnique(household.careOptions, (entry) => entry.id, '取れる手', report);
  const arrangements = indexUnique(plan.arrangements, (entry) => entry.key, '手配', report);
  const tasks = indexUnique(plan.tasks, (entry) => entry.key, '作業', report);
  indexUnique(plan.questions, (entry) => entry.key, '問い', report);
  indexUnique(plan.requests, (entry) => entry.requestId, '依頼', report);
  indexUnique(
    plan.arrangements.flatMap((entry) => entry.options),
    (entry) => entry.key,
    '案',
    report,
  );
  for (const requirement of plan.requirements) {
    if (requirement.live && requirement.kind === 'need') {
      for (const id of requirement.basis.itemIds) {
        const item = facts.items.get(id);
        if (item?.kind !== 'need' || facts.active.get(id) !== true || facts.staleItems.has(id))
          continue;
        const value = item.interpretation;
        if (
          value.forMemberId &&
          !household.members.some((member) => member.id === value.forMemberId)
        )
          report.violation(
            'need_member_unknown',
            requirement.key,
            'することの対象が家庭の成員にいない。',
          );
        if (value.shape === 'by' && value.deadline) {
          const expected = needDeadline(item, household.timeZone);
          if (expected === undefined) continue;
          if (!requirement.by) {
            report.undetermined(
              'need_deadline_unverified',
              requirement.key,
              '事項の締切と要件を照らせない。',
            );
          } else if (
            instantMinute(requirement.by) !== expected &&
            !(value.deadlineDayOnly && instantMinute(requirement.by) === expected + 1)
          ) {
            report.violation(
              value.deadlineDayOnly ? 'need_day_deadline_mismatch' : 'need_deadline_mismatch',
              requirement.key,
              '要件の締切が元の事項と違う。',
            );
          }
        }
      }
    }
    // 家にあると示す時は、その言明が家族の最後の答えと品物に対応するかを、事象から確かめる。
    // 別の出典の作用・退休・欠落で答えが変わり得る時は、ここでは断定しない。
    if (
      requirement.kind === 'belongings' &&
      requirement.atHome !== undefined &&
      !requirement.atHomeUnknownId
    ) {
      report.undetermined(
        'at_home_answer_unverified',
        requirement.key,
        '持ち物についての答えの識別子が無い。',
      );
    }
    if (
      requirement.kind === 'belongings' &&
      requirement.atHome !== undefined &&
      requirement.atHomeUnknownId
    ) {
      const id = requirement.atHomeUnknownId;
      const possibleOtherAnswer = otherAnswerPossible(history.events, id);
      if (!history.complete || possibleOtherAnswer) {
        report.undetermined(
          'at_home_answer_unverified',
          requirement.key,
          '持ち物についての家族の答えを独立に確かめられない。',
        );
      } else {
        const answer = history.events.findLast(
          (entry) => entry.type === 'answered' && entry.unknownId === id,
        );
        if (
          answer?.type !== 'answered' ||
          answer.value !== requirement.atHome ||
          (answer.about !== undefined && answer.about !== requirement.what)
        )
          report.violation(
            'at_home_answer_mismatch',
            requirement.key,
            '持ち物に示した答えが、最後の答えか、その時の品物と違う。',
          );
      }
    }
    if (requirement.kind === 'belongings' && requirement.bought === true) {
      // 手配が締切後に消えても、安定した要件キーから購入作業の事象をたどる。形が未知なら断定しない。
      const prefix = 'req:belongings:';
      const root = requirement.key.startsWith(prefix) ? requirement.key.slice(prefix.length) : '';
      const taskKey = root ? `task:opt:arr:purchase:${root}:buy:buy` : '';
      if (!history.complete || !taskKey || history.requestBasedDone.has(taskKey)) {
        report.undetermined(
          'belonging_bought_unverified',
          requirement.key,
          '買い終えた事象を独立に確かめられない。',
        );
      } else if (history.commitments.get(taskKey) !== 'done') {
        report.violation(
          'belonging_bought_mismatch',
          requirement.key,
          '購入を済ませた事象がない。',
        );
      } else {
        const content = history.doneContents.get(taskKey);
        if (!content) {
          report.undetermined(
            'belonging_bought_unverified',
            requirement.key,
            '昔の済みには購入した品物の控えが無い。',
          );
        } else if (
          content.titleKey !== 'task.buy' ||
          Object.keys(content.titleParams).length !== 1 ||
          content.titleParams.what !== requirement.what
        ) {
          report.violation(
            'belonging_bought_mismatch',
            requirement.key,
            '済ませた購入の品物と、今の品物が違う。',
          );
        } else {
          const unknownId = `u-atHome:${root}`;
          const answer = history.events.findLast(
            (entry) => entry.type === 'answered' && entry.unknownId === unknownId,
          );
          const doneSeq = history.commitmentSeq.get(taskKey);
          if (
            answer?.type === 'answered' &&
            (answer.value === 'yes' || answer.value === 'no') &&
            (answer.about === undefined || answer.about === requirement.what) &&
            doneSeq !== undefined &&
            answer.seq > doneSeq
          ) {
            const family = history.events.findLast(
              (entry) => entry.type === 'householdSet' && entry.seq <= answer.seq,
            );
            const member =
              family?.type === 'householdSet'
                ? family.household.members.find((entry) => entry.id === answer.actorId)
                : undefined;
            if (
              member?.kind !== 'adult' ||
              !member.active ||
              otherAnswerPossible(history.events, unknownId)
            )
              report.undetermined(
                'belonging_bought_unverified',
                requirement.key,
                '購入の後の答えを独立に確かめられない。',
              );
            else
              report.violation(
                'belonging_bought_mismatch',
                requirement.key,
                '購入の後に持ち物の状態を答え直している。',
              );
          }
        }
      }
    }
    checkBasis(requirement.basis, requirement.key, requirement.live, facts, plan, report, false);
    if (requirement.live && requirement.nature === 'required') {
      if (
        requirement.kind === 'childCare' &&
        !plan.arrangements.some(
          (entry) => entry.live && entry.requirementKey === requirement.key,
        ) &&
        !dayCoveredAtHome(household, plan, requirement.date)
      ) {
        report.undetermined(
          'required_arrangement_missing',
          requirement.key,
          '必須の子の居場所を満たす手配を確認できない。',
        );
      }
      if (
        requirement.kind === 'belongings' &&
        requirement.by !== undefined &&
        instantMinute(requirement.by) > instantMinute(plan.now) &&
        !plan.arrangements.some(
          (entry) =>
            entry.kind === 'purchase' && entry.live && entry.requirementKey === requirement.key,
        )
      ) {
        // 家にあると答えた場合も手配は出ない。答えと現在の品物の対応をここでは再生していないため、
        // 手配が無いことだけから読み落としや違反と断定しない。
        report.undetermined(
          'purchase_arrangement_absence_unverified',
          requirement.key,
          '持ち物の手配が無い理由を、家にあるかの答えまで含めて確認できない。',
        );
      }
      for (const id of requirement.basis.itemIds) {
        const item = facts.items.get(id);
        const correction = facts.corrections.get(id);
        if (requirement.basis.itemIds.length === 1 && requirement.kind === 'attendance')
          checkDutyTurn(id, requirement.key, facts, history, report);
        if (facts.staleItems.has(id) && requirement.conditional !== true) {
          report.violation(
            'stale_item_unmarked',
            requirement.key,
            '書き直し前の読み取りによる要件を、確かな物としている。',
          );
        }
        // 一つの事項に対応する品物・提出物なら、現在の読み取り（家族の直しを含む）と要件の名前を照らせる。
        // 置き換えで両方とも旧い名前のままになれば、作業と要件の相互比較だけでは気づけない。
        if (
          requirement.basis.itemIds.length === 1 &&
          item &&
          ((requirement.kind === 'belongings' && item.kind === 'belongings') ||
            (requirement.kind === 'submission' &&
              (item.kind === 'submission' ||
                (item.kind === 'homework' && item.interpretation.familyAction === true))) ||
            (requirement.kind === 'attendance' &&
              item.kind === 'duty' &&
              item.interpretation.familyAction === true)) &&
          requirement.what !== (item.interpretation.what ?? item.written)
        ) {
          if (facts.staleItems.has(id) || facts.active.get(id) !== true)
            report.undetermined(
              'requirement_content_unverified',
              requirement.key,
              '元の事項の適用や読み取りを確かめられず、現在の用件を照らせない。',
            );
          else
            report.violation(
              'requirement_content_mismatch',
              requirement.key,
              '要件の用件が、元の事項の今の用件と違う。',
            );
        }
        if (
          requirement.basis.itemIds.length === 1 &&
          ((requirement.kind === 'childCare' && item?.kind === 'dayChange') ||
            (requirement.kind === 'belongings' && item?.kind === 'belongings') ||
            (requirement.kind === 'attendance' &&
              item?.kind === 'duty' &&
              item.interpretation.familyAction === true)) &&
          requirement.date &&
          item.interpretation.date &&
          requirement.date !== item.interpretation.date
        ) {
          if (facts.staleItems.has(id) || facts.active.get(id) !== true)
            report.undetermined(
              'requirement_date_unverified',
              requirement.key,
              '元の事項の適用や読み取りを確かめられず、要件の日を照らせない。',
            );
          else
            report.violation(
              'requirement_date_mismatch',
              requirement.key,
              '要件の日が、元の事項の今の日と違う。',
            );
        }
        if (
          requirement.kind === 'belongings' &&
          requirement.date &&
          item?.kind === 'belongings' &&
          item.interpretation.date === undefined
        ) {
          report.undetermined(
            'requirement_date_unverified',
            requirement.key,
            '持ち物を使う日が元の事項に明記されていない。',
          );
        }
        if (
          requirement.basis.itemIds.length === 1 &&
          requirement.kind === 'attendance' &&
          item?.kind === 'duty' &&
          item.interpretation.familyAction === true &&
          item.interpretation.date !== undefined &&
          requirement.date === undefined
        ) {
          if (facts.staleItems.has(id) || facts.active.get(id) !== true)
            report.undetermined(
              'requirement_date_unverified',
              requirement.key,
              '元の事項の適用や読み取りを確かめられず、要件の日を照らせない。',
            );
          else
            report.violation(
              'requirement_date_mismatch',
              requirement.key,
              '当番の日が元の事項にあるのに、要件から欠けている。',
            );
        }
        if (
          requirement.basis.itemIds.length === 1 &&
          requirement.kind === 'attendance' &&
          item?.kind === 'duty' &&
          item.interpretation.familyAction === true &&
          item.interpretation.date === undefined &&
          requirement.date !== undefined
        ) {
          report.undetermined(
            'requirement_date_unverified',
            requirement.key,
            '当番の日を元の事項から確かめられない。',
          );
        }
        if (
          requirement.kind === 'belongings' &&
          item?.kind === 'belongings' &&
          correction?.what &&
          requirement.what !== correction.what
        ) {
          if (facts.staleItems.has(id)) {
            report.undetermined(
              'corrected_requirement_stale',
              requirement.key,
              '書き直し前の訂正と現在の要件を照らせない。',
            );
          } else {
            report.violation(
              'corrected_requirement_mismatch',
              requirement.key,
              '家族が直した品名と要件が違う。',
            );
          }
        }
        if (item && (item.evidence === 'inferred' || item.evidence === 'conflicting')) {
          report.violation(
            'unconfirmed_required_item',
            requirement.key,
            '未確認の推定・食い違いから必須の要件を作っている。',
          );
        }
      }
    }
  }
  for (const arrangement of plan.arrangements) {
    const requirement = requirements.get(arrangement.requirementKey);
    if (!requirement)
      report.violation('arrangement_requirement_missing', arrangement.key, '手配の要件がない。');
    else if (arrangement.live && !requirement.live)
      report.violation(
        'arrangement_requirement_inactive',
        arrangement.key,
        '不要な要件から手配が残っている。',
      );
    if (!arrangement.live) continue;
    if (arrangement.kind === 'need') {
      const item = needItem(arrangement, plan, facts);
      const window = statedWindow(timedNeedItem(item, windows));
      if (!item?.interpretation.shape) {
        report.undetermined(
          'need_shape_unverified',
          arrangement.key,
          'することの形を元の事項から確かめられない。',
        );
      } else if (arrangement.needShape === undefined) {
        report.undetermined('need_shape_missing', arrangement.key, '手配にすることの形がない。');
      } else if (arrangement.needShape !== item.interpretation.shape) {
        report.violation('need_shape_mismatch', arrangement.key, '手配の形が元の事項と違う。');
      }
      if (item?.interpretation.shape === 'window' && !window) {
        report.undetermined(
          'need_window_unverified',
          arrangement.key,
          '受け持つ窓を元の事項から確かめられない。',
        );
      } else if (
        window &&
        (instantMinute(arrangement.start) !== window.start ||
          instantMinute(arrangement.end) !== window.end)
      ) {
        report.violation('need_window_mismatch', arrangement.key, '手配の窓が元の事項と違う。');
      }
      if (item?.interpretation.shape === 'by') {
        const deadline = needDeadline(item, household.timeZone);
        if (deadline === undefined) {
          report.undetermined(
            'need_deadline_unverified',
            arrangement.key,
            'することの締切を元の事項から確かめられない。',
          );
        } else if (
          instantMinute(arrangement.end) !== deadline &&
          !(item.interpretation.deadlineDayOnly && instantMinute(arrangement.end) === deadline + 1)
        ) {
          report.violation(
            'need_deadline_mismatch',
            arrangement.key,
            '手配の締切が元の事項と違う。',
          );
        }
      }
    }
    if (arrangement.kind === 'purchase') {
      const requirementUnknown =
        requirement?.kind === 'belongings' ? requirement.atHomeUnknownId : undefined;
      if (
        arrangement.atHomeUnknownId !== undefined &&
        requirementUnknown !== undefined &&
        arrangement.atHomeUnknownId !== requirementUnknown
      ) {
        report.violation(
          'purchase_unknown_mismatch',
          arrangement.key,
          '買い物の手配と要件が別の「家にあるか」を指している。',
        );
      }
      if (arrangement.status === 'askFirst') {
        const expectedUnknown = arrangement.atHomeUnknownId ?? requirementUnknown;
        if (arrangement.atHomeUnknownId === undefined || requirementUnknown === undefined) {
          report.undetermined(
            'purchase_unknown_unverified',
            arrangement.key,
            '買い物の手配と要件の「家にあるか」を照らせない。',
          );
        }
        for (const reason of arrangement.reasons.filter((entry) => entry.code === 'askFirst')) {
          for (const ref of reason.refs) {
            const question = plan.questions.find((entry) => entry.key === ref);
            if (!question) continue; // 問いの不在は checkReasons が検出する。
            if (expectedUnknown !== undefined && question.unknownId !== expectedUnknown) {
              report.violation(
                'purchase_question_unknown_mismatch',
                question.key,
                '買い物の問いが、別の「家にあるか」を指している。',
              );
            }
            if (!question.affects.includes(arrangement.key)) {
              report.violation(
                'purchase_question_target_mismatch',
                question.key,
                '買い物の問いが、その手配に影響すると記されていない。',
              );
            }
          }
        }
      }
    }
    if (
      arrangement.kind === 'childCare' &&
      requirement?.kind === 'childCare' &&
      requirement.date &&
      localMinute(instantMinute(arrangement.start), household.timeZone).date !== requirement.date
    )
      report.violation(
        'arrangement_requirement_date_mismatch',
        arrangement.key,
        '子の居場所の手配の日が、要件の日と違う。',
      );
    if (instantMinute(arrangement.end) < instantMinute(arrangement.start)) {
      report.violation('arrangement_time_invalid', arrangement.key, '手配の終わりが始まりより前。');
    }
    checkReasons(arrangement, plan, household, facts, history, report, household.timeZone, windows);
    for (const option of arrangement.options) {
      if (option.arrangementKey !== arrangement.key)
        report.violation('option_arrangement_mismatch', option.key, '案が別の手配を指している。');
      const way =
        arrangement.kind === 'need'
          ? household.ways.find((entry) => entry.id === option.templateId)
          : undefined;
      const stopped =
        arrangement.kind === 'need' && household.stoppedWayIds?.includes(option.templateId);
      if ((option.stopped === true) !== (stopped === true))
        report.violation(
          'stopped_way_flag_mismatch',
          option.key,
          '案の停止状態が、家族のやり方の記録と違う。',
        );
      const careTemplate =
        arrangement.kind === 'need'
          ? undefined
          : household.careOptions.find((entry) => entry.id === option.templateId);
      const registeredCost = way?.cost ?? careTemplate?.cost;
      if (registeredCost) {
        const fields = ['leaveMinutes', 'helperRequests', 'yen', 'extraTasks'] as const;
        const expectedUnknown = new Set(registeredCost.unknown ?? []);
        const shownUnknown = new Set(option.cost.unknown ?? []);
        if (
          fields.some(
            (field) =>
              registeredCost[field] !== option.cost[field] ||
              expectedUnknown.has(field) !== shownUnknown.has(field),
          )
        )
          report.violation(
            'option_cost_mismatch',
            option.key,
            '案の代償または分からない欄が、家族の登録と違う。',
          );
      }
      checkNoSlot(household, option, way, careTemplate, report);
      if (!careTemplate && !way) {
        if (arrangement.kind === 'purchase') {
          report.undetermined(
            'purchase_template_unverified',
            option.key,
            '買い物の案を家庭の取れる手の雛形とは照らせない。',
          );
        } else {
          report.violation('option_template_missing', option.key, '案の取れる手がない。');
        }
      }
      if (
        (option.deadlineCertainty === 'undetermined') !==
        (option.decisionDeadline === undefined)
      ) {
        report.violation(
          'decision_deadline_inconsistent',
          option.key,
          '決め時と確かさの状態が一致しない。',
        );
      }
      const past = isPastDecision(option, plan);
      const rulePast =
        past === 'unknown'
          ? ruleDeadlinePast(option, arrangement, household, plan, facts, history, report, windows)
          : past;
      if (rulePast !== 'unknown' && option.expired !== rulePast)
        report.violation('expired_state_mismatch', option.key, '決め時の経過と計画の状態が違う。');
      for (const key of option.taskKeys)
        if (!tasks.has(key))
          report.violation('option_task_missing', option.key, '案が存在しない作業を指している。');
      if ((careTemplate || way?.deadline) && option.decisionDeadline) {
        const date = way
          ? needDate(timedNeedItem(needItem(arrangement, plan, facts), windows), household.timeZone)
          : undefined;
        const deadline = careTemplate
          ? optionDeadline(household, arrangement, careTemplate, report)
          : date && way?.deadline
            ? deadlineOnDate(household, date, way.deadline, option.key, report)
            : undefined;
        if (deadline !== undefined && instantMinute(option.decisionDeadline) > deadline) {
          report.violation(
            'decision_after_rule_deadline',
            option.key,
            '決め時が家庭の申込期限より後。',
          );
        }
      }
    }
    if (
      new Set(arrangement.backupOptionKeys).size !== arrangement.backupOptionKeys.length ||
      (arrangement.chosenOptionKey &&
        arrangement.backupOptionKeys.includes(arrangement.chosenOptionKey))
    ) {
      report.violation(
        'duplicate_selected_option',
        arrangement.key,
        '本命と予備、または予備同士が重複している。',
      );
    }
    for (const key of [
      arrangement.recommendedOptionKey,
      arrangement.chosenOptionKey,
      ...arrangement.backupOptionKeys,
    ]) {
      if (key && !arrangement.options.some((option) => option.key === key))
        report.violation(
          'selected_option_missing',
          arrangement.key,
          '選択または推薦した案が手配の中にない。',
        );
    }
    const recommended = arrangement.options.find(
      (option) => option.key === arrangement.recommendedOptionKey,
    );
    if (recommended) {
      if (recommended.noSlot) {
        report.violation(
          'no_slot_recommended',
          recommended.key,
          '時刻を決められない案を、進め方として推薦している。',
        );
      }
      if (recommended.decisionDeadline) {
        report.undetermined(
          'latest_deadline_unproved',
          recommended.key,
          '決め時が最も遅い時刻かは独立に証明していない。',
        );
      } else {
        report.undetermined(
          'decision_deadline_unknown',
          recommended.key,
          '推薦した案の決め時が分からない。',
        );
      }
      if (
        isPastDecision(recommended, plan) === true &&
        !optionStarted(recommended, arrangement, plan, history, household.timeZone)
      ) {
        if (
          arrangement.chosenOptionKey === recommended.key ||
          arrangement.backupOptionKeys.includes(recommended.key)
        ) {
          report.undetermined(
            'started_option_unknown',
            recommended.key,
            '選択済みの案が期限内に実行され始めたか分からない。',
          );
        } else {
          report.violation(
            'expired_option_recommended',
            recommended.key,
            '決め時を過ぎた未選択の案を推薦している。',
          );
        }
      }
    }
    const selection = history.selections.get(arrangement.key);
    const selectedKeys = history.complete
      ? [selection?.primary, ...(selection?.backups ?? [])].filter(
          (key): key is string => key !== undefined,
        )
      : [arrangement.chosenOptionKey, ...arrangement.backupOptionKeys].filter(
          (key): key is string => key !== undefined,
        );
    const selected = selectedKeys
      .map((key) => arrangement.options.find((option) => option.key === key))
      .filter((option): option is OptionPlan => option !== undefined);
    const failures = new Map(
      selected.map((option) => [
        option.key,
        optionFailure(option, arrangement, plan, history, household.timeZone),
      ]),
    );
    if (recommended && (arrangement.kind === 'need' || arrangement.kind === 'childCare')) {
      const open = arrangement.options.filter(
        (entry) =>
          entry.decisionDeadline !== undefined && !entry.expired && !failures.get(entry.key),
      );
      const templates = open.map((entry) => ({
        option: entry,
        way:
          arrangement.kind === 'need'
            ? household.ways.find((way) => way.id === entry.templateId)
            : undefined,
        care:
          arrangement.kind === 'childCare'
            ? household.careOptions.find((care) => care.id === entry.templateId)
            : undefined,
      }));
      if (templates.some(({ way }) => way && household.stoppedWayIds?.includes(way.id)))
        report.violation(
          'stopped_way_recommended',
          arrangement.key,
          'やめたやり方の開いた案があるのに、案を勧めている。',
        );
      if (
        templates.some(({ way, care }) =>
          (way?.steps ?? (care ? [...care.steps, ...care.extraSteps] : [])).some((step) => {
            const place = household.places.find((entry) => entry.id === step.placeId);
            return (
              place !== undefined &&
              place.kind !== 'home' &&
              (!place.hours ||
                place.hours.source === 'googlePlaces' ||
                place.hours.periods.some((period) => period.open === period.close))
            );
          }),
        )
      )
        report.violation(
          'unverified_hours_recommended',
          arrangement.key,
          '行ける時間を確かめられない場所のある案が残るのに、案を勧めている。',
        );
      if (
        open.length > 1 &&
        templates.some(
          ({ way, care }) => (way?.cost.unknown ?? care?.cost.unknown ?? []).length > 0,
        )
      )
        report.violation(
          'unknown_cost_recommended',
          arrangement.key,
          '代償の分からない案があり比較できないのに、案を勧めている。',
        );
    }
    for (const option of selected) {
      if (
        isPastDecision(option, plan) === true &&
        optionStarted(option, arrangement, plan, history, household.timeZone) &&
        !optionStarted(option, arrangement, plan, history, household.timeZone, true)
      )
        report.undetermined(
          'option_start_time_unverified',
          option.key,
          '作業は進んでいるが、決め時までに始めたか確かめられない。',
        );
    }
    if (history.complete) {
      for (const option of selected) {
        const failure = failures.get(option.key);
        if (!failure) continue;
        if (failure.code === 'missedDeadline')
          report.undetermined(
            'option_start_unverified',
            option.key,
            '済んだ・送った記録がなく、作業を始めたか分からない。',
          );
        const reported = arrangement.reasons.some(
          (reason) =>
            reason.code === failure.code && failure.refs.some((ref) => reason.refs.includes(ref)),
        );
        if (!reported && failure.code === 'turnedDown')
          report.violation(
            'rejected_option_unreported',
            option.key,
            '断られた案の理由が示されていない。',
          );
        else if (!reported)
          report.undetermined(
            'missed_deadline_unreported',
            option.key,
            '決め時後も進捗の記録がなく、手配の状態を確認できない。',
          );
      }
    }
    const usable = selected.find((option) => !failures.get(option.key));
    const replacement =
      recommended &&
      !optionFailure(recommended, arrangement, plan, history, household.timeZone) &&
      isPastDecision(recommended, plan) === false
        ? recommended
        : undefined;
    const inUseFailure = arrangement.inUseOptionKey
      ? failures.get(arrangement.inUseOptionKey)
      : undefined;
    if (history.complete && inUseFailure?.code === 'turnedDown')
      report.violation(
        'failed_option_treated_as_valid',
        arrangement.key,
        '断られた本命・予備を使っている。',
      );
    else if (history.complete && inUseFailure?.code === 'missedDeadline')
      report.undetermined(
        'failed_option_treated_as_valid',
        arrangement.key,
        '進捗の記録がない案を使えるか分からない。',
      );
    // 推薦は、代償や行ける時間が分からず出せないことがある。推薦が無くても、開いた別の案があれば
    // 「選び直せる」と言えるので、推薦の不在だけで違反にしない。
    const openAlternative = arrangement.options.some(
      (option) =>
        option.decisionDeadline !== undefined && !option.expired && !failures.get(option.key),
    );
    if (
      history.complete &&
      arrangement.status === 'decidable' &&
      selected.length > 0 &&
      !usable &&
      !replacement &&
      !openAlternative &&
      !inUseFailure
    ) {
      if (selected.some((option) => failures.get(option.key)?.code === 'missedDeadline'))
        report.undetermined(
          'failed_option_treated_as_valid',
          arrangement.key,
          '進捗の記録がない案で手配が成立するか分からない。',
        );
      else
        report.violation(
          'failed_option_treated_as_valid',
          arrangement.key,
          '使えなくなった本命・予備の代わりがないまま決めてよいとしている。',
        );
    }
    const subjectOption =
      usable ?? replacement ?? (selected.length === 0 ? recommended : undefined);
    const waiting = subjectOption
      ? [...history.requests.values()].filter(
          (request) =>
            subjectOption.taskKeys.includes(request.taskKey) && request.state === 'awaitingReply',
        )
      : [];
    const waitingToday = waiting.some(
      (request) =>
        matchesArrangementDay(
          request.snapshot?.window,
          arrangement,
          household.timeZone,
          history.needShapes.get(arrangement.key),
        ) === true,
    );
    const waitingUnknown = waiting.some(
      (request) =>
        matchesArrangementDay(
          request.snapshot?.window,
          arrangement,
          household.timeZone,
          history.needShapes.get(arrangement.key),
        ) === undefined,
    );
    if (arrangement.status === 'decidable' && subjectOption && (waitingToday || waitingUnknown)) {
      const priorUnknown = selected
        .slice(0, selected.indexOf(subjectOption))
        .some((option) => failures.get(option.key)?.code === 'missedDeadline');
      if (priorUnknown || !waitingToday)
        report.undetermined(
          'decidable_waiting_reply',
          arrangement.key,
          waitingUnknown && !waitingToday
            ? '返事待ちの依頼が今の日の分か確かめられない。'
            : '進捗が不明な本命と返事待ちの予備を確認できない。',
        );
      else
        report.violation(
          'decidable_waiting_reply',
          arrangement.key,
          '外の返事待ちがある案を条件なしで決めてよいとしている。',
        );
    }
  }
  for (const task of plan.tasks) {
    // 買う物・用意して出す物の作業名は、今の要件と同じ物を指す。済んだ時の控えと作業だけが
    // 同じ古い品名であっても、要件と食い違っていれば前の物の済みを当てられない。
    const requirement = task.basis.requirementKey
      ? requirements.get(task.basis.requirementKey)
      : undefined;
    if (
      task.live &&
      requirement?.live &&
      ((task.titleKey === 'task.buy' && requirement.kind === 'belongings') ||
        ((task.titleKey === 'task.submit' || task.titleKey === 'task.familyAction') &&
          requirement.kind === 'submission') ||
        (task.titleKey === 'task.duty' && requirement.kind === 'attendance')) &&
      task.titleParams.what !== requirement.what
    ) {
      report.violation(
        'task_requirement_content_mismatch',
        task.key,
        '作業の用件が、今の要件に書かれた物と違う。',
      );
    }
    // 当番の用件には、後から変わると別の作業になる日・時刻・場所も入る。
    // 作業と承諾の控えの両方に同じ古い値を入れた場合も、元の事項と照らせる。
    if (task.live && task.titleKey === 'task.duty' && task.basis.itemIds.length === 1) {
      const id = task.basis.itemIds[0];
      const item = id ? facts.items.get(id) : undefined;
      if (id) checkDutyTurn(id, task.key, facts, history, report);
      if (id && item?.kind === 'duty' && item.interpretation.familyAction === true) {
        // 書かれた始まりを確かめられなかった印を落とすと、札が「時刻は書かれていない」と言い、
        // 通知も当日の終わりまで待ってしまう。後から始まりを確かめた物には適用しない。
        if (
          item.interpretation.date !== undefined &&
          item.interpretation.startTimeUnconfirmed === true &&
          item.interpretation.startTime === undefined &&
          task.timeUnconfirmed !== true
        ) {
          if (!history.complete || facts.staleItems.has(id) || facts.active.get(id) !== true) {
            report.undetermined(
              'duty_time_confidence_unverified',
              task.key,
              '当番の元の開始時刻を確かめられない。',
            );
          } else {
            report.violation(
              'duty_time_confidence_mismatch',
              task.key,
              '確かめられなかった開始時刻を、作業に示していない。',
            );
          }
        }
        const expected: Record<string, string | undefined> = {
          date: item.interpretation.date,
          start: item.interpretation.startTime,
          end: item.interpretation.endTime,
          place: item.interpretation.place,
        };
        const differs = Object.entries(expected).some(
          ([key, value]) => task.titleParams[key] !== value,
        );
        if (differs) {
          if (facts.staleItems.has(id) || facts.active.get(id) !== true) {
            report.undetermined(
              'duty_content_unverified',
              task.key,
              '当番の元の内容を確かめられない。',
            );
          } else {
            report.violation(
              'duty_content_mismatch',
              task.key,
              '当番の用件の日・時刻・場所が、今の事項と違う。',
            );
          }
        }
      }
    }
    // 担当が決まる前の開始・終了も含め、決まった時刻の当番を元の事項と照らす。
    if (task.live && task.titleKey === 'task.duty' && task.basis.itemIds.length === 1) {
      const id = task.basis.itemIds[0];
      const item = id ? facts.items.get(id) : undefined;
      if (id && item?.kind === 'duty' && item.interpretation.familyAction === true) {
        const { date, startTime, endTime } = item.interpretation;
        if (date && startTime) {
          const expectedStart = dateIndex(date) + timeOfDay(startTime);
          const localIndex = (value: string) =>
            localMinute(instantMinute(value), household.timeZone).localIndex;
          const endMinute = endTime === undefined ? undefined : timeOfDay(endTime);
          const startMinute = timeOfDay(startTime);
          const nextDayLength =
            endMinute === undefined ? undefined : 1440 - startMinute + endMinute;
          // 日をまたぐと書かれた時刻を、同日終了や翌日終了と勝手に取り違えない。
          const expectedEnd =
            endMinute === undefined
              ? undefined
              : endMinute > startMinute
                ? dateIndex(date) + endMinute
                : nextDayLength !== undefined && nextDayLength <= 12 * 60
                  ? dateIndex(date) + 1440 + endMinute
                  : undefined;
          const startsDiffer =
            task.earliestStart === undefined ||
            localIndex(task.earliestStart) !== expectedStart ||
            (task.start !== undefined && localIndex(task.start) !== expectedStart);
          const endsDiffer =
            expectedEnd !== undefined &&
            (task.deadline === undefined ||
              localIndex(task.deadline) !== expectedEnd ||
              (task.end !== undefined && localIndex(task.end) !== expectedEnd));
          if (startsDiffer || endsDiffer) {
            if (facts.staleItems.has(id) || facts.active.get(id) !== true) {
              report.undetermined(
                'duty_time_unverified',
                task.key,
                '当番の元の時刻を確かめられない。',
              );
            } else {
              report.violation(
                'duty_time_mismatch',
                task.key,
                '当番の開始・終了が、元の事項に書かれた時刻と違う。',
              );
            }
          }
          if (endTime && expectedEnd === undefined)
            report.undetermined(
              'duty_time_unverified',
              task.key,
              '当番の終了が同日か翌日か確かめられない。',
            );
        }
      }
    }
    if (
      task.live &&
      task.step &&
      requirement?.live &&
      requirement.kind === 'childCare' &&
      requirement.date &&
      task.titleParams.date !== requirement.date
    )
      report.violation(
        'task_requirement_date_mismatch',
        task.key,
        '手配の手順の用件の日が、今の要件の日と違う。',
      );
    checkBasis(
      task.basis,
      task.key,
      task.live,
      facts,
      plan,
      report,
      task.commitment === 'done' || Boolean(task.cancels),
    );
    checkStep(task, household, plan, facts, report, windows);
    if (task.live && !task.cancels && task.basis.optionKey && task.basis.arrangementKey) {
      const arrangement = arrangements.get(task.basis.arrangementKey);
      const active =
        arrangement &&
        (arrangement.chosenOptionKey === task.basis.optionKey ||
          arrangement.backupOptionKeys.includes(task.basis.optionKey));
      if (arrangement && !active && task.commitment === 'accepted') {
        report.undetermined(
          'unselected_option_assignment',
          task.key,
          '以前に選んだ案の引き受けが不要になったか確認できない。',
        );
      }
    }
    for (const dependency of task.after) {
      if (!tasks.has(dependency.taskKey))
        report.violation('dependency_missing', task.key, '先行する作業がない。');
      if (dependency.taskKey === task.key)
        report.violation('dependency_self', task.key, '作業が自分自身を待っている。');
    }
  }
  const marks = new Map<string, 'visiting' | 'done'>();
  const visit = (key: string): void => {
    if (marks.get(key) === 'done') return;
    if (marks.get(key) === 'visiting') {
      report.violation('dependency_cycle', key, '作業の先後が循環している。');
      return;
    }
    marks.set(key, 'visiting');
    const task = tasks.get(key);
    if (task?.live)
      for (const dependency of task.after)
        if (tasks.has(dependency.taskKey)) visit(dependency.taskKey);
    marks.set(key, 'done');
  };
  for (const task of plan.tasks) if (task.live) visit(task.key);
  for (const request of plan.requests) {
    const original = history.requests.get(request.requestId)?.snapshot;
    const requestedArrangement = plan.arrangements.find(
      (entry) => entry.key === request.basis.arrangementKey,
    );
    // 根拠の不確かさは計画の needsCheck ではなく、送信時の控えと事象から判定する。
    const originalStates = original?.basis.itemIds.map((id) => historicalItem(facts, id).active);
    const uncertain =
      originalStates !== undefined &&
      (originalStates.some((active) => active === 'unknown') ||
        (originalStates.some((active) => active === false) &&
          originalStates.some((active) => active !== false)));
    checkBasis(
      request.basis,
      request.requestId,
      request.live,
      facts,
      plan,
      report,
      false,
      uncertain,
      original !== undefined,
      requestedArrangement?.kind !== 'need'
        ? undefined
        : !history.complete || original === undefined
          ? 'unknown'
          : !sameBasis(original.basis, request.basis)
            ? false
            : history.needRequestSentValid.get(request.requestId) === true
              ? true
              : 'unknown',
    );
  }
  for (const question of plan.questions) {
    const owners = plan.requirements.filter(
      (entry) => entry.kind === 'belongings' && entry.atHomeUnknownId === question.unknownId,
    );
    const purchases = plan.arrangements.filter(
      (entry) => entry.kind === 'purchase' && entry.atHomeUnknownId === question.unknownId,
    );
    if ((owners.length > 0 || purchases.length > 0) && question.askBy === undefined)
      report.violation(
        'purchase_question_ask_by_missing',
        question.key,
        '持ち物の問いに聞く期限がない。',
      );
    if ((owners.length > 0 || purchases.length > 0) && question.fallbackValue !== 'no')
      report.violation(
        'purchase_question_default_invalid',
        question.key,
        '持ち物の問いの既定の答えが「ない」でない。',
      );
    const ownerInactive =
      owners.length > 0
        ? owners.every((entry) => !entry.live)
        : purchases.length > 0 && purchases.every((entry) => !entry.live);
    if (ownerInactive) {
      report.violation(
        'purchase_question_inactive',
        question.key,
        '不要な持ち物の「家にあるか」を、答える問いとして残している。',
      );
    }
    if (!facts.unknowns.has(question.unknownId)) {
      report.undetermined(
        'question_unknown_not_declared',
        question.key,
        '問いの対象と答えの候補を事象から確認できない。',
      );
    }
    for (const key of question.affects) {
      const affected = arrangements.has(key)
        ? [arrangements.get(key)].filter((entry): entry is Arrangement => Boolean(entry?.live))
        : plan.arrangements.filter((entry) => entry.live && entry.requirementKey === key);
      if (!arrangements.has(key) && !requirements.has(key)) {
        report.violation(
          'question_target_missing',
          question.key,
          '問いが存在しない手配または要件を指している。',
        );
      }
      for (const arrangement of affected) {
        const options = arrangement.options.filter(
          (option) => isPastDecision(option, plan) !== true,
        );
        const expiredBeforeQuestion = options.filter(
          (option) =>
            question.askBy !== undefined &&
            option.decisionDeadline &&
            instantMinute(question.askBy) > instantMinute(option.decisionDeadline),
        );
        if (options.length === 1 && expiredBeforeQuestion.length === 1) {
          report.violation(
            'question_after_decision',
            question.key,
            '問いの期限が、それで変わる案の決め時より後。',
          );
        } else if (expiredBeforeQuestion.length > 0) {
          report.undetermined(
            'question_option_scope_unknown',
            question.key,
            'どの案が回答で変わるか分からず、問いの期限を確かめられない。',
          );
        }
      }
    }
  }
  checkFamilyQuestions(plan, facts, history, report);
  checkEscort(household, plan, facts, history, report);
}
