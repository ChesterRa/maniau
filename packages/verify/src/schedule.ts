import type { Household, Place, PlanResult, RoutineSegment, Task } from '@maniau/core';
import { checkDetour } from './detour';
import type { History } from './history';
import type { Collector } from './report';
import { executionScope, isRecommended } from './scope';
import {
  coveredBy,
  dateFromIndex,
  dayStarts,
  type Interval,
  instantMinute,
  localMinute,
  overlaps,
  timeOfDay,
  weekday,
} from './time';

interface ScheduledTask {
  task: Task;
  start: number;
  end: number;
  occupied: Interval;
}

function allowedSegments(
  household: Household,
  scheduled: ScheduledTask,
  report: Collector,
): RoutineSegment[] {
  const { task, occupied } = scheduled;
  if (!task.assigneeId) return [];
  const localStart = localMinute(occupied.start, household.timeZone).localIndex;
  const localEnd = localMinute(occupied.end, household.timeZone).localIndex;
  const days = dayStarts(localStart, localEnd);
  if (!days) {
    report.undetermined('routine_range', task.key, '長い作業の全区間を確認できない。');
    return [];
  }
  const intervals: Interval[] = [];
  const candidates: RoutineSegment[] = [];
  for (const day of days) {
    const dayOfWeek = weekday(dateFromIndex(day));
    const routines = household.routines.filter(
      (routine) => routine.memberId === task.assigneeId && routine.weekday === dayOfWeek,
    );
    if (routines.length > 1) {
      report.violation('duplicate_routine', task.key, '同じ人・曜日のふだんの週が重複している。');
    }
    for (const routine of routines) {
      for (const segment of routine.segments) {
        const start = timeOfDay(segment.start);
        const end = timeOfDay(segment.end);
        if (start >= end) {
          report.violation('invalid_routine', task.key, 'ふだんの週の区間の始まりと終わりが不正。');
          continue;
        }
        if (!task.segments.includes(segment.kind)) continue;
        const selectedPlace = task.atPlaceId ?? task.placeId;
        if (
          selectedPlace &&
          segment.placeId &&
          segment.kind !== 'commute' &&
          segment.placeId !== selectedPlace &&
          task.travelSource === 'none'
        ) {
          continue;
        }
        intervals.push({ start: day + start, end: day + end });
        candidates.push(segment);
      }
    }
  }
  if (!coveredBy(localStart, localEnd, intervals)) {
    report.violation('outside_routine', task.key, '移動を含む作業が、許された区間に収まらない。');
  }
  return candidates;
}

function checkOpeningHours(
  household: Household,
  scheduled: ScheduledTask,
  place: Place,
  report: Collector,
): void {
  const { task, start, end } = scheduled;
  if (!place.hours) {
    report.undetermined('opening_hours_missing', task.key, '場所の営業時間が分からない。');
    return;
  }
  const hours = place.hours;
  if (hours.source === 'googlePlaces') {
    if (!hours.checkedAt) {
      report.undetermined(
        'opening_hours_source_time_missing',
        task.key,
        '地図の営業時間を調べた時刻がない。',
      );
      return;
    }
    const checkedAt = instantMinute(hours.checkedAt);
    if (start < checkedAt || end > checkedAt + 7 * 24 * 60) {
      report.undetermined(
        'opening_hours_out_of_range',
        task.key,
        '地図の営業時間を確認できる期間の外。',
      );
      return;
    }
    // 周期の時刻と取得時刻だけでは、店の時区・実際の有効期間・臨時営業を確かめられない。
    // 日付別の根拠を受け取れるまでは、営業時間外や休業と決めない。
    report.undetermined(
      'opening_hours_coverage_unverified',
      task.key,
      '地図の営業時間を確かめた期間と店の時区を照らせない。',
    );
    return;
  }
  const localStart = localMinute(start, household.timeZone).localIndex;
  const localEnd = localMinute(end, household.timeZone).localIndex;
  const days = dayStarts(localStart, localEnd);
  if (!days) {
    report.undetermined('opening_hours_range', task.key, '長い作業の営業時間を確認できない。');
    return;
  }
  for (const day of days) {
    if (hours.closedDates.includes(dateFromIndex(day))) {
      report.violation('place_closed', task.key, '作業の日は場所が休み。');
      return;
    }
  }
  const intervals: Interval[] = [];
  let ambiguous = false;
  // 前日の夜から翌朝までの営業時間も含める。
  const first = days[0];
  if (first === undefined) return;
  for (const day of [first - 24 * 60, ...days]) {
    if (hours.closedDates.includes(dateFromIndex(day))) continue;
    const dayOfWeek = weekday(dateFromIndex(day));
    for (const period of hours.periods.filter((entry) => entry.weekday === dayOfWeek)) {
      const open = timeOfDay(period.open);
      let close = timeOfDay(period.close);
      if (open === close) {
        ambiguous = true;
        report.undetermined(
          'opening_hours_ambiguous',
          task.key,
          '開店と閉店が同時刻で、終日か休みか分からない。',
        );
        continue;
      }
      if (close < open) close += 24 * 60;
      intervals.push({ start: day + open, end: day + close });
    }
  }
  if (!coveredBy(localStart, localEnd, intervals) && !ambiguous) {
    report.violation('outside_opening_hours', task.key, '作業そのものが営業時間に収まらない。');
  }
}

function checkPlace(
  household: Household,
  scheduled: ScheduledTask,
  routines: readonly RoutineSegment[],
  report: Collector,
): void {
  const { task } = scheduled;
  if (task.placeId && task.atPlaceId && task.placeId !== task.atPlaceId) {
    report.violation('wrong_place', task.key, '決められた場所と置いた場所が違う。');
  }
  const placeId = task.atPlaceId ?? task.placeId;
  if (!placeId) {
    if (task.placeKind || task.goods || task.travelBeforeMin || task.travelAfterMin) {
      report.undetermined('place_missing', task.key, '作業する場所が決まっていない。');
    }
    return;
  }
  const place = household.places.find((candidate) => candidate.id === placeId);
  if (!place) {
    report.violation('unknown_place', task.key, '置いた場所が家族の情報にない。');
    return;
  }
  if (task.placeKind && task.placeKind !== place.kind) {
    report.violation('wrong_place_kind', task.key, '必要な場所の種類と置いた場所が違う。');
  }
  if (task.goods && !place.goods.includes(task.goods)) {
    report.undetermined(
      'goods_unconfirmed',
      task.key,
      'この場所で必要な品物を扱うか確認できない。',
    );
  }
  if (place.kind === 'store') checkOpeningHours(household, scheduled, place, report);

  if (task.travelSource === 'maps') {
    report.undetermined(
      'route_evidence_missing',
      task.key,
      '地図の道のりの根拠を検証器に渡せない。',
    );
  } else if (task.travelSource === 'estimate') {
    const station = place.nearStationId;
    const walk = place.walkFromStationMin;
    const stationOnRoutine =
      station !== undefined &&
      routines.some(
        (segment) => segment.placeId === station || segment.viaStationIds.includes(station),
      );
    if (walk === undefined || !stationOnRoutine) {
      report.undetermined('route_estimate_missing', task.key, '徒歩の目安と通る駅を照らせない。');
    } else {
      if (task.travelBeforeMin < walk || task.travelAfterMin < walk) {
        report.violation('route_too_short', task.key, '駅から店までの徒歩の目安より移動が短い。');
      }
      report.undetermined('route_is_estimate', task.key, '徒歩と乗り換えの実際の道のりは未確認。');
    }
  } else if (
    task.travelBeforeMin > 0 ||
    task.travelAfterMin > 0 ||
    (place.kind === 'store' && !routines.some((segment) => segment.placeId === place.id))
  ) {
    report.undetermined('route_unconfirmed', task.key, '作業場所への移動の根拠がない。');
  }
}

export function checkSchedule(
  household: Household,
  plan: PlanResult,
  history: History,
  report: Collector,
): void {
  const placed: ScheduledTask[] = [];
  const tasksByKey = new Map(plan.tasks.map((task) => [task.key, task]));
  for (const task of plan.tasks) {
    if (task.handoff && (task.start || task.end || task.atPlaceId))
      report.violation(
        'handoff_scheduled',
        task.key,
        '受け渡しが未確認の作業に時刻または場所が置かれている。',
      );
    const scope = executionScope(task, plan, household, history);
    if (scope === 'inactive') continue;
    if (task.handoff && !task.start && !task.end && !task.atPlaceId && scope !== 'candidate')
      report.undetermined(
        'handoff_unverified',
        task.key,
        '別の担当への受け渡しの方法を確認できない。',
      );
    if (task.start === undefined && task.end === undefined) {
      if (task.detour)
        report.violation('detour_time_missing', task.key, '時刻のない作業に寄り道がある。');
      continue;
    }
    if (task.start === undefined || task.end === undefined) {
      report.violation('partial_time', task.key, '作業の始まりか終わりがない。');
      continue;
    }
    if (!task.assigneeId) {
      report.violation('assignee_missing', task.key, '時刻を置いた作業の担当がない。');
      continue;
    }
    const member = household.members.find((candidate) => candidate.id === task.assigneeId);
    if (member?.kind !== 'adult' || !member.active) {
      report.violation('invalid_assignee', task.key, '担当が有効な大人ではない。');
    }
    const start = instantMinute(task.start);
    const end = instantMinute(task.end);
    if (end < start || end - start !== task.durationMin) {
      report.violation('duration_mismatch', task.key, '作業時間と始まり・終わりが一致しない。');
      continue;
    }
    if (task.earliestStart && start < instantMinute(task.earliestStart)) {
      report.violation('before_earliest_start', task.key, '最早の開始より前に始まる。');
    }
    if (task.deadline && end > instantMinute(task.deadline)) {
      report.violation('after_deadline', task.key, '締切を過ぎて終わる。');
    }
    const scheduled: ScheduledTask = {
      task,
      start,
      end,
      occupied: {
        start: start - task.travelBeforeMin,
        end: Math.max(
          end + task.travelAfterMin,
          task.detour ? instantMinute(task.detour.delayedArrival) : end,
        ),
      },
    };
    if (task.commitment === 'done' && end < instantMinute(plan.now)) {
      report.undetermined(
        'historical_routine_unverified',
        task.key,
        '完了時の予定と場所の情報を確認できない。',
      );
    } else {
      const routines = task.detour
        ? checkDetour(household, plan, history, task, start, end, report)
        : allowedSegments(household, scheduled, report);
      checkPlace(household, scheduled, routines, report);
    }
    placed.push(scheduled);
  }

  for (const [index, current] of placed.entries()) {
    for (const other of placed.slice(index + 1)) {
      if (
        current.task.assigneeId === other.task.assigneeId &&
        overlaps(current.occupied, other.occupied)
      ) {
        const currentScope = executionScope(current.task, plan, household, history);
        const otherScope = executionScope(other.task, plan, household, history);
        const first = current.task.basis;
        const second = other.task.basis;
        const sameArrangement =
          first.arrangementKey && first.arrangementKey === second.arrangementKey;
        const sameOption =
          sameArrangement && first.optionKey && first.optionKey === second.optionKey;
        const differentOptions =
          sameArrangement &&
          first.optionKey &&
          second.optionKey &&
          first.optionKey !== second.optionKey;
        if (differentOptions && (currentScope === 'candidate' || otherScope === 'candidate'))
          continue;
        if (currentScope === 'unknown' || otherScope === 'unknown') {
          report.undetermined(
            'task_overlap_scope_unknown',
            current.task.key,
            '重なる作業が同時に必要か分からない。',
            other.task.key,
          );
        } else if (
          sameOption ||
          (currentScope === 'active' && otherScope === 'active') ||
          (currentScope === 'candidate' &&
            isRecommended(current.task, plan) &&
            (otherScope === 'active' || isRecommended(other.task, plan))) ||
          (otherScope === 'candidate' &&
            isRecommended(other.task, plan) &&
            (currentScope === 'active' || isRecommended(current.task, plan)))
        ) {
          report.violation(
            'task_overlap',
            current.task.key,
            `同じ担当の作業 ${other.task.key} と重なる。`,
            other.task.key,
          );
        } else if (currentScope === 'active' || otherScope === 'active') {
          report.undetermined(
            'candidate_overlap_unknown',
            current.task.key,
            '比較中の案が既存の作業と両立するか分からない。',
            other.task.key,
          );
        }
      }
    }
    for (const predecessor of current.task.after) {
      const previous = tasksByKey.get(predecessor.taskKey);
      if (!previous) {
        report.violation('predecessor_missing', current.task.key, '先に行う作業がない。');
      } else if (!previous.end) {
        report.undetermined(
          'predecessor_unscheduled',
          current.task.key,
          '先に行う作業の終わりがない。',
        );
      } else if (current.start < instantMinute(previous.end) + predecessor.waitMin) {
        report.violation(
          'predecessor_wait',
          current.task.key,
          '先行作業の終了と待ち時間を守れない。',
        );
      }
    }
  }
}
