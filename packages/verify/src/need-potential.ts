// 窓型の案が、必要な約束が全てそろっても、今の情報では受け持てると示せない時間を独立に確かめる。
// まだ引き受けていない・返事待ちという今の状態は、潜在的な受け持ちとは分ける。
import type { Household, OptionPlan, PlanResult, Way } from '@maniau/core';
import type { FactState } from './facts';
import type { History } from './history';
import type { Collector } from './report';
import { routinesOn } from './routine';
import { type Interval, instantMinute } from './time';

/** 使う日の地域の時刻。家庭の型は現在 Asia/Tokyo に限る。 */
function localTime(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00+09:00`) / 60_000;
}

/** 案の約束がそろっても覆えると示せない窓。元の事項と家庭から求め、計画の印は使わない。 */
function potentialGaps(
  whole: Interval,
  date: string,
  place: string | undefined,
  way: Way,
): Interval[] {
  if (
    !way.steps.some((step) => step.cover === true) ||
    (place !== undefined && way.steps.some((step) => step.cover === true && !step.external))
  ) {
    return [whole];
  }
  if (!way.covers) return [];
  const start = localTime(date, way.covers.start);
  const end = localTime(date, way.covers.end);
  if (end <= whole.start || start >= whole.end) return [whole];
  return [
    ...(start > whole.start ? [{ start: whole.start, end: Math.min(start, whole.end) }] : []),
    ...(end < whole.end ? [{ start: Math.max(end, whole.start), end: whole.end }] : []),
  ];
}

/** 欄は見せ方の根拠なので、同じ区間の順番・時区表記が違っても同じ瞬間なら同じとする。 */
function sameGaps(
  expected: readonly Interval[],
  actual: readonly { start: string; end: string }[],
) {
  const values = actual
    .map((gap) => ({ start: instantMinute(gap.start), end: instantMinute(gap.end) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  return (
    values.length === expected.length &&
    expected.every((gap, i) => gap.start === values[i]?.start && gap.end === values[i]?.end)
  );
}

/** PlanResult の安全な parse を通った印。 */
const gapsOf = (option: OptionPlan): readonly { start: string; end: string }[] =>
  option.coverGaps ?? [];

/** 担当の記録は計画の作業から推量せず、事象を順にたどる。 */
function recordedAssignee(history: History, taskKey: string): string | undefined {
  let assigned: string | undefined;
  for (const event of history.events) {
    if (event.type === 'assignmentProposed' && event.taskKey === taskKey) {
      assigned = event.assigneeId;
    } else if (
      event.type === 'commitmentChanged' &&
      event.taskKey === taskKey &&
      event.actorId === event.assigneeId &&
      (assigned === undefined || assigned === event.assigneeId)
    ) {
      assigned = event.assigneeId;
    }
  }
  return assigned;
}

type Placement = { kind: 'placed' | 'unknown' } | { kind: 'unplaced'; unproved: boolean };

/**
 * 固定された家族の受け持ちを窓に置けるか。日程の一つの区間が窓を含まなければ置けないと独立に分かる。
 * 日程が足りていても、ほかの作業や営業時間で置けない場合はある。空の時刻と印の整合を見て、原因は未判定にする。
 */
function familyPlacement(
  household: Household,
  plan: PlanResult,
  history: History,
  option: OptionPlan,
  way: Way,
  date: string,
  whole: Interval,
): Placement {
  let unknown = false;
  let unplaced = false;
  let unproved = false;
  for (const step of way.steps.filter((entry) => entry.cover === true && !entry.external)) {
    const key = `task:${option.key}:${step.id}`;
    const assigned = step.assigneeId ?? recordedAssignee(history, key);
    if (assigned === undefined) continue; // 誰がするか未定なら、これを理由に印を付けない。
    const tasks = plan.tasks.filter(
      (task) =>
        task.key === key &&
        task.basis.optionKey === option.key &&
        task.step?.templateId === way.id &&
        task.step.stepId === step.id &&
        task.cover === true,
    );
    const task = tasks[0];
    if (tasks.length !== 1 || !task || task.assigneeId !== assigned) {
      unknown = true;
      continue;
    }
    const days = routinesOn(household, assigned, date);
    if (days.length > 1) {
      unknown = true;
      continue;
    }
    const routineFits = days.some((day) =>
      day.segments.some(
        (segment) =>
          step.segments.includes(segment.kind) &&
          (step.placeId === undefined || segment.placeId === step.placeId) &&
          localTime(date, segment.start) <= whole.start &&
          localTime(date, segment.end) >= whole.end,
      ),
    );
    if (!routineFits) {
      unplaced = true; // 日程だけで置けないと分かる（例外の日は routinesOn が先に使う）。
      continue;
    }
    if (!task.start && !task.end) {
      unplaced = true;
      unproved = true;
    } else if (
      !task.start ||
      !task.end ||
      instantMinute(task.start) !== whole.start ||
      instantMinute(task.end) !== whole.end
    ) {
      unknown = true; // 作業時刻が窓と違う件は別の検査でも確かめる。
    }
  }
  if (unplaced) return { kind: 'unplaced', unproved };
  return { kind: unknown ? 'unknown' : 'placed' };
}

export function checkNeedPotentialCoverage(
  household: Household,
  plan: PlanResult,
  facts: FactState,
  history: History,
  report: Collector,
): void {
  for (const arrangement of plan.arrangements) {
    if (!arrangement.live || arrangement.options.length === 0) continue;
    if (arrangement.kind !== 'need') {
      for (const option of arrangement.options) {
        if (gapsOf(option).length > 0)
          report.violation(
            'need_potential_gap_unexpected',
            option.key,
            '窓のすることではない案に、受け持てない時間を出している。',
          );
      }
      continue;
    }
    const shape = history.needShapes.get(arrangement.key);
    if (!history.complete) {
      report.undetermined(
        'need_potential_unverified',
        arrangement.key,
        '事象の列がそろわず、案の窓とやり方を確かめられない。',
      );
      continue;
    }
    if (shape === 'by') {
      for (const option of arrangement.options) {
        if (gapsOf(option).length > 0)
          report.violation(
            'need_potential_gap_unexpected',
            option.key,
            '締切型の案に、受け持てない時間を出している。',
          );
      }
      continue;
    }
    const requirement = plan.requirements.find((entry) => entry.key === arrangement.requirementKey);
    const itemId =
      requirement?.basis.itemIds.length === 1 ? requirement.basis.itemIds[0] : undefined;
    const item = itemId ? facts.items.get(itemId) : undefined;
    const interpretation = item?.interpretation;
    const choice = history.needWays.get(arrangement.key);
    const date = interpretation?.date;
    const start = interpretation?.startTime;
    const end = interpretation?.endTime;
    if (
      shape !== 'window' ||
      !itemId ||
      item?.kind !== 'need' ||
      facts.active.get(itemId) !== true ||
      facts.staleItems.has(itemId) ||
      choice?.state !== 'current' ||
      !date ||
      !start ||
      !end ||
      start >= end
    ) {
      report.undetermined(
        'need_potential_unverified',
        arrangement.key,
        '案の窓と家族が選んだやり方を、事象から確かめられない。',
      );
      continue;
    }
    const whole = { start: localTime(date, start), end: localTime(date, end) };
    for (const option of arrangement.options) {
      const ways = household.ways.filter((entry) => entry.id === option.templateId);
      if (ways.length !== 1 || !ways[0] || !choice.optionKeys.has(option.key)) {
        report.undetermined(
          'need_potential_unverified',
          option.key,
          '案のやり方と家族の選びを、事象から確かめられない。',
        );
        continue;
      }
      if (ways[0].covers && ways[0].covers.start >= ways[0].covers.end) {
        report.undetermined(
          'need_potential_unverified',
          option.key,
          'やり方の受け持てる時間が不正で、案を確かめられない。',
        );
        continue;
      }
      const structural = potentialGaps(whole, date, interpretation?.place, ways[0]);
      // 形だけで全窓と決まる時は、置き方の確認が足りなくても結論は変わらない。
      const allStructural =
        structural.length === 1 &&
        structural[0]?.start === whole.start &&
        structural[0]?.end === whole.end;
      const placement = allStructural
        ? { kind: 'placed' as const }
        : familyPlacement(household, plan, history, option, ways[0], date, whole);
      const expected = placement.kind === 'unplaced' ? [whole] : structural;
      const actual = gapsOf(option);
      const mismatch =
        placement.kind === 'unknown'
          ? !sameGaps(structural, actual) && !sameGaps([whole], actual)
          : !sameGaps(expected, actual);
      if (mismatch) {
        report.violation(
          'need_potential_gap_mismatch',
          option.key,
          '案が受け持てると示せない時間の印が、窓とやり方に合わない。',
        );
      }
      if (
        (actual.length > 0 || (placement.kind !== 'unknown' && expected.length > 0)) &&
        arrangement.recommendedOptionKey === option.key
      ) {
        report.violation(
          'need_potential_gap_recommended',
          option.key,
          '窓の全体を受け持てると示せない案を勧めている。',
        );
      }
      if (placement.kind === 'unknown' || (placement.kind === 'unplaced' && placement.unproved)) {
        report.undetermined(
          'need_potential_placement_unverified',
          option.key,
          '受け持つ人の置き方を、日程と作業の記録だけでは独立に確かめられない。',
        );
      }
    }
  }
}
