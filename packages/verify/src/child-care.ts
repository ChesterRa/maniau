// 手配が無くても、登録された一日とほかの作業から在宅を独立に確認できる場合だけ認める。
import type { Household, PlanResult } from '@maniau/core';
import { routinesOn } from './routine';
import { dateIndex, instantMinute, localMinute, overlaps, timeOfDay } from './time';

export function dayCoveredAtHome(
  household: Household,
  plan: PlanResult,
  date: string | undefined,
): boolean {
  if (!date) return false;
  const from = dateIndex(date);
  const to = from + 24 * 60;
  const homeIds = new Set(
    household.places.filter((place) => place.kind === 'home').map((p) => p.id),
  );
  return household.members.some((member) => {
    if (member.kind !== 'adult' || !member.active) return false;
    const routines = routinesOn(household, member.id, date);
    if (routines.length !== 1) return false;
    const segments = routines[0]?.segments;
    if (!segments?.length) return false;
    const ordered = [...segments].sort((a, b) => timeOfDay(a.start) - timeOfDay(b.start));
    for (const [index, segment] of ordered.entries()) {
      if (
        segment.kind !== 'home' ||
        segment.placeId === undefined ||
        !homeIds.has(segment.placeId) ||
        timeOfDay(segment.start) >= timeOfDay(segment.end) ||
        (index > 0 && ordered[index - 1]?.end !== segment.start)
      )
        return false;
    }
    // 時刻のない作業はその日の外にあると決められない。どこでできるかに関わらず、
    // その日の作業があれば、子を見られる時間を別に確認する（過去の済みは除く）。
    return !plan.tasks.some((task) => {
      if (
        task.assigneeId !== member.id ||
        !task.live ||
        ['done', 'declined', 'withdrawn', 'cancelled'].includes(task.commitment)
      )
        return false;
      if (!task.start || !task.end) return true;
      const start = instantMinute(task.start) - task.travelBeforeMin;
      const end = Math.max(
        instantMinute(task.end) + task.travelAfterMin,
        task.detour ? instantMinute(task.detour.delayedArrival) : instantMinute(task.end),
      );
      const startLocal = localMinute(start, household.timeZone).localIndex;
      const endLocal = localMinute(end, household.timeZone).localIndex;
      return overlaps({ start: from, end: to }, { start: startLocal, end: endLocal });
    });
  });
}
