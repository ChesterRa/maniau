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

/**
 * その人のその日の区間。その日だけの一日（routineExceptions）があればそれを、無ければふだんの曜日の一日を使う。
 * 計算の区間は全部ここを通る（子の居場所・買い物・決め時・すること）。
 */
export function slotsOn(household: Household, memberId: string, date: LocalDate): Slot[] {
  const exception = household.routineExceptions.find(
    (e) => e.memberId === memberId && e.date === date,
  );
  const weekday = weekdayOf(date);
  const segments =
    exception?.segments ??
    household.routines.find((r) => r.memberId === memberId && r.weekday === weekday)?.segments;
  if (!segments) return [];
  return segments.map((s) => toSlot(household, memberId, date, s));
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

type Interval = { start: EpochMinutes; end: EpochMinutes };

/** 時刻の順に並べ、重なる・接する区間を一つにする。 */
function merged(intervals: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const interval of [...intervals].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else out.push({ start: interval.start, end: interval.end });
  }
  return out;
}

/** 二つの、並べて一つにした区間の列の重なり。 */
function intersected(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a[i] as Interval;
    const y = b[j] as Interval;
    const start = Math.max(x.start, y.start);
    const end = Math.min(x.end, y.end);
    if (start < end) out.push({ start, end });
    if (x.end < y.end) i += 1;
    else j += 1;
  }
  return out;
}

/**
 * その日、子を見られる大人が家にいない時間（子の居場所の手配が要る時間）。
 * 有効な大人の誰もが「家」以外の区間（通勤・仕事・迎え・外出）にいると書かれている時間の重なりを返す。
 * 「家」の区間だけを、子を見られる時間として数える（家で仕事をして見られない時は「仕事」と書く。画面にも
 * 書く）。一日は家で始まり家で終わるとし、最初の区間の前と最後の区間の後は家にいるとする。区間の間の
 * 空きは、家の外とは決めない（分からない時間で、手配の要る時間を広げない）。朝だけ家にいて帰らない日や、
 * 一日中出かけている日は、その外の区間の全部が手配の要る時間になる（手配は黙って消えない）。その日の
 * 区間が無い大人は、分からないので数えず、ほかの大人だけで決める。どの大人にも区間が無ければ返さない。
 */
export function noAdultAtHome(household: Household, date: LocalDate): Interval[] {
  const away = activeAdultIds(household)
    .map((id) => slotsOn(household, id, date))
    .filter((slots) => slots.length > 0)
    .map((slots) => merged(slots.filter((s) => s.kind !== 'home')));
  const [first, ...rest] = away;
  if (!first) return [];
  return rest.reduce(intersected, first);
}
