// ふだんの週から、ある人・ある日の区間を、実際の時刻（紀元からの分）にする。
// 区間に無い時刻は、作業を置けない時刻として扱う（docs/design/01-model.md §3 ふだんの週）。
import type { Household, RoutineSegment, SegmentKind } from '../schema/household';
import {
  addDays,
  type EpochMinutes,
  type LocalDate,
  weekdayOf,
  zonedToEpochMinutes,
} from '../time';

export interface Slot {
  memberId: string;
  date: LocalDate;
  start: EpochMinutes;
  end: EpochMinutes;
  kind: SegmentKind;
  placeId?: string;
  fromId?: string;
  toId?: string;
  viaStationIds: readonly string[];
}

export function activeAdultIds(household: Household): string[] {
  return household.members.filter((m) => m.kind === 'adult' && m.active).map((m) => m.id);
}

export function slotsOn(household: Household, memberId: string, date: LocalDate): Slot[] {
  const weekday = weekdayOf(date);
  const day = household.routines.find((r) => r.memberId === memberId && r.weekday === weekday);
  if (!day) return [];
  return day.segments.map((s) => toSlot(household, memberId, date, s));
}

function toSlot(household: Household, memberId: string, date: LocalDate, s: RoutineSegment): Slot {
  const slot: Slot = {
    memberId,
    date,
    start: zonedToEpochMinutes(date, s.start, household.timeZone),
    end: zonedToEpochMinutes(date, s.end, household.timeZone),
    kind: s.kind,
    viaStationIds: s.viaStationIds,
  };
  if (s.placeId !== undefined) slot.placeId = s.placeId;
  if (s.fromId !== undefined) slot.fromId = s.fromId;
  if (s.toId !== undefined) slot.toId = s.toId;
  return slot;
}

/** from の日から to の日まで（両端を含む）の区間を、時刻の順に返す。 */
export function slotsBetweenDates(
  household: Household,
  memberId: string,
  from: LocalDate,
  to: LocalDate,
): Slot[] {
  const slots: Slot[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    slots.push(...slotsOn(household, memberId, date));
  }
  return slots.sort((a, b) => a.start - b.start);
}

/**
 * その日、大人が誰も家にいない時間（子の居場所の手配が要る時間）。
 * 大人の home の区間を合わせ、その外で、最初に家を出てから最後に帰るまでを返す。
 */
export function noAdultAtHome(
  household: Household,
  date: LocalDate,
): { start: EpochMinutes; end: EpochMinutes }[] {
  const home = activeAdultIds(household)
    .flatMap((id) => slotsOn(household, id, date))
    .filter((s) => s.kind === 'home')
    .map((s) => ({ start: s.start, end: s.end }))
    .sort((a, b) => a.start - b.start);
  if (home.length === 0) return [];
  const merged: { start: number; end: number }[] = [];
  for (const interval of home) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  const gaps: { start: number; end: number }[] = [];
  for (let i = 0; i + 1 < merged.length; i += 1) {
    const current = merged[i];
    const next = merged[i + 1];
    if (current && next && next.start > current.end)
      gaps.push({ start: current.end, end: next.start });
  }
  return gaps;
}
