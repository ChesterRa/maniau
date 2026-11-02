import type { Household, PlanResult, RoutineSegment, Task } from '@maniau/core';
import type { History } from './history';
import type { Collector } from './report';
import { executionScope, isRecommended } from './scope';
import { coveredBy, instantMinute, localMinute, overlaps, timeOfDay, weekday } from './time';

/** 同じ担当が直近の提案で見た時刻だけを、今の時刻の確認として扱う。 */
function acceptedCurrentTime(task: Task, history: History): boolean {
  if (
    !history.complete ||
    task.commitment !== 'accepted' ||
    !task.assigneeId ||
    !task.start ||
    !task.end ||
    !task.detour
  )
    return false;
  let assigned: string | undefined;
  let accepted: { start: string; end: string; delayedArrival?: string } | undefined;
  for (const event of history.events) {
    if (event.type === 'assignmentProposed' && event.taskKey === task.key) {
      assigned = event.assigneeId;
      accepted = undefined;
    } else if (event.type === 'commitmentChanged' && event.taskKey === task.key) {
      if (event.actorId !== event.assigneeId || (assigned && event.assigneeId !== assigned))
        continue;
      assigned = event.assigneeId;
      if (event.action === 'accept' && assigned === task.assigneeId) {
        accepted = event.shown;
      } else {
        accepted = undefined;
      }
    } else if (event.type === 'externalRequestSent' && event.taskKey === task.key) {
      accepted = undefined;
    }
  }
  return Boolean(
    accepted?.delayedArrival &&
      instantMinute(accepted.start) === instantMinute(task.start) &&
      instantMinute(accepted.end) === instantMinute(task.end) &&
      instantMinute(accepted.delayedArrival) === instantMinute(task.detour.delayedArrival),
  );
}

/** 作息だけでなく、その人に実際に置いた外出・寄り道も確かめる。 */
function checkOtherAdult(
  household: Household,
  plan: PlanResult,
  history: History,
  task: Task,
  homeId: string,
  planned: number,
  delayed: number,
  report: Collector,
): void {
  const startLocal = localMinute(planned, household.timeZone);
  const endLocal = localMinute(delayed, household.timeZone);
  const dayOfWeek = weekday(startLocal.date);
  let uncertain = false;
  for (const adult of household.members.filter(
    (member) => member.kind === 'adult' && member.active && member.id !== task.assigneeId,
  )) {
    const routine = household.routines.find(
      (entry) => entry.memberId === adult.id && entry.weekday === dayOfWeek,
    );
    if (!routine) {
      uncertain = true;
      continue;
    }
    const homeIntervals = routine.segments
      .filter((segment) => segment.kind === 'home' && segment.placeId === homeId)
      .map((segment) => ({ start: timeOfDay(segment.start), end: timeOfDay(segment.end) }));
    if (!coveredBy(startLocal.minuteOfDay, endLocal.minuteOfDay, homeIntervals)) {
      const knownAway = routine.segments.some(
        (segment) =>
          (segment.kind !== 'home' ||
            (segment.placeId !== undefined && segment.placeId !== homeId)) &&
          overlaps(
            { start: startLocal.minuteOfDay, end: endLocal.minuteOfDay },
            { start: timeOfDay(segment.start), end: timeOfDay(segment.end) },
          ),
      );
      if (!knownAway) uncertain = true;
      continue;
    }
    let unavailable = false;
    let taskUnknown = false;
    for (const other of plan.tasks) {
      if (other.assigneeId !== adult.id || other.key === task.key) continue;
      const scope = executionScope(other, plan, household, history);
      if (scope === 'inactive' || (scope === 'candidate' && !isRecommended(other, plan))) continue;
      const place = other.atPlaceId ?? other.placeId;
      const away = Boolean(other.detour) || (place !== undefined && place !== homeId);
      const knownHome =
        !other.detour &&
        place === homeId &&
        other.travelBeforeMin === 0 &&
        other.travelAfterMin === 0;
      const inferredHome =
        !place &&
        other.segments.every((segment) => segment === 'home') &&
        other.travelBeforeMin === 0 &&
        other.travelAfterMin === 0;
      if (knownHome || inferredHome) continue;
      if (!other.start || !other.end) {
        taskUnknown = true;
        continue;
      }
      const occupied = {
        start: instantMinute(other.start) - other.travelBeforeMin,
        end: Math.max(
          instantMinute(other.end) + other.travelAfterMin,
          other.detour ? instantMinute(other.detour.delayedArrival) : instantMinute(other.end),
        ),
      };
      if (!overlaps({ start: planned, end: delayed }, occupied)) continue;
      if (away && (scope === 'active' || isRecommended(other, plan))) unavailable = true;
      else taskUnknown = true;
    }
    if (!unavailable && !taskUnknown) return;
    if (!unavailable && taskUnknown) uncertain = true;
  }
  if (uncertain) {
    report.undetermined(
      'detour_other_adult_unverified',
      task.key,
      '他の大人が遅れた到家まで家にいるか、作業の場所から確かめられない。',
    );
  } else {
    report.violation(
      'detour_other_adult_absent',
      task.key,
      '遅れた到家まで家にいる別の大人を確認できない。',
    );
  }
}

/** 家族の元の区間と歩く時間から、寄り道で遅れる到家を照らす。 */
export function checkDetour(
  household: Household,
  plan: PlanResult,
  history: History,
  task: Task,
  start: number,
  end: number,
  report: Collector,
): RoutineSegment[] {
  if (!task.detour || !task.assigneeId) return [];
  if (!task.segments.includes('commute')) {
    report.violation(
      'detour_segment_not_allowed',
      task.key,
      '帰り道の作業に通勤の区間が許されていない。',
    );
  }
  const planned = instantMinute(task.detour.plannedArrival);
  const delayed = instantMinute(task.detour.delayedArrival);
  if (delayed < planned || delayed < end + task.travelAfterMin) {
    report.violation(
      'detour_arrival_invalid',
      task.key,
      '寄り道の後の到家が作業や元の到家より前。',
    );
  }
  const plannedLocal = localMinute(planned, household.timeZone);
  const delayedLocal = localMinute(delayed, household.timeZone);
  if (plannedLocal.date !== delayedLocal.date) {
    report.undetermined('detour_crosses_day', task.key, '日をまたぐ帰宅の変更を確認できない。');
    return [];
  }
  const dayOfWeek = weekday(plannedLocal.date);
  const routines = household.routines.filter(
    (entry) => entry.memberId === task.assigneeId && entry.weekday === dayOfWeek,
  );
  if (routines.length > 1) {
    report.violation('duplicate_routine', task.key, '同じ人・曜日のふだんの週が重複している。');
  }
  const routine = routines[0];
  const index =
    routine?.segments.findIndex(
      (segment) =>
        segment.kind === 'commute' &&
        timeOfDay(segment.end) === plannedLocal.minuteOfDay &&
        household.places.some((place) => place.id === segment.toId && place.kind === 'home'),
    ) ?? -1;
  const commute = routine?.segments[index];
  if (!commute) {
    report.violation('detour_commute_missing', task.key, '元の到家時刻に終わる帰宅の区間がない。');
    return [];
  }
  const next = routine?.segments[index + 1];
  if (next?.kind !== 'home' || next.start !== commute.end || next.placeId !== commute.toId) {
    report.violation(
      'detour_fixed_commitment',
      task.key,
      '帰宅の直後に、遅らせられる家の区間がない。',
    );
    return [commute];
  }
  if (delayedLocal.minuteOfDay > timeOfDay(next.end)) {
    report.violation('detour_after_home_slot', task.key, '遅れた到家が家の区間の終わりを越える。');
  }
  if (!acceptedCurrentTime(task, history)) {
    report.undetermined(
      'detour_home_flexibility_unverified',
      task.key,
      'この作業の時刻と遅れた到家を、担当が確認したか分からない。',
    );
  }
  const home = household.places.find((place) => place.id === commute.toId);
  const store = household.places.find((place) => place.id === (task.atPlaceId ?? task.placeId));
  if (!home || !store || store.kind !== 'store') {
    report.undetermined('detour_places_missing', task.key, '家と店を照らせない。');
    return [commute, next];
  }
  checkOtherAdult(household, plan, history, task, home.id, planned, delayed, report);
  const station = commute.viaStationIds.at(-1);
  if (!station || !home.nearStationId || !store.nearStationId) {
    report.undetermined(
      'detour_station_missing',
      task.key,
      '通る駅と家・店の最寄り駅を照らせない。',
    );
  } else if (station !== home.nearStationId || station !== store.nearStationId) {
    report.violation('detour_station_mismatch', task.key, '帰りの駅と家・店の最寄り駅が違う。');
  }
  const homeWalk = home.walkFromStationMin;
  const storeWalk = store.walkFromStationMin;
  if (homeWalk === undefined || storeWalk === undefined || task.travelSource !== 'estimate') {
    report.undetermined(
      'detour_route_missing',
      task.key,
      '駅から家と店への歩く時間を独立に照らせない。',
    );
  } else {
    if (task.travelBeforeMin !== storeWalk || task.travelAfterMin !== storeWalk) {
      report.violation('detour_walk_mismatch', task.key, '店と駅の往復が家族の徒歩の目安と違う。');
    }
    const atStation = planned - homeWalk;
    if (plannedLocal.minuteOfDay - homeWalk < timeOfDay(commute.start)) {
      report.violation(
        'detour_station_before_commute',
        task.key,
        '到駅が通勤の始まりより前になる。',
      );
    }
    const expectedStart = atStation + storeWalk;
    const expectedDelayed = planned + storeWalk * 2 + task.durationMin;
    if (
      start !== expectedStart ||
      end !== expectedStart + task.durationMin ||
      delayed !== expectedDelayed
    ) {
      report.violation(
        'detour_time_mismatch',
        task.key,
        '到駅・買い物・到家の時刻が徒歩と所要時間に合わない。',
      );
    }
  }
  return [commute, next];
}
