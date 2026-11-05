// ふだんの週から、ある人・ある日の区間を、実際の時刻（紀元からの分）にする。
// 区間に無い時刻は、作業を置けない時刻として扱う（docs/design/01-model.md §3 ふだんの週）。
import type { Household, RoutineSegment, SegmentKind } from '../schema/household';
import {
  addDays,
  type EpochMinutes,
  type LocalDate,
  localDateOf,
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

/**
 * その人のその日の、手が離せない時間（家庭の unavailable。実際の時刻にし、時刻の順に並べて一つにした物）。その間、
 * その人は子を見守れず、作業も置かない。
 */
export function unavailableOn(household: Household, memberId: string, date: LocalDate): Interval[] {
  return merged(
    (household.unavailable ?? [])
      .filter((u) => u.memberId === memberId && u.date === date)
      .map((u) => ({
        start: zonedToEpochMinutes(date, u.start, household.timeZone),
        end: zonedToEpochMinutes(date, u.end, household.timeZone),
      })),
  );
}

/** その人の手が離せない時間が、[start, end) と重なるか。 */
export function unavailableDuring(
  household: Household,
  memberId: string,
  start: EpochMinutes,
  end: EpochMinutes,
): boolean {
  const tz = household.timeZone;
  const dates = new Set([localDateOf(start, tz), localDateOf(Math.max(start, end - 1), tz)]);
  return [...dates].some((date) =>
    unavailableOn(household, memberId, date).some((u) => u.start < end && start < u.end),
  );
}

/**
 * from の日から to の日までの区間から、その人の手が離せない時間を除いた物（作業を置く・受け持つ所で使う）。区間の
 * 種類と場所は元のまま（場所の区間そのものは切らない。切るのは、ここで使う写しだけ）。
 */
export function freeSlotsBetweenDates(
  household: Household,
  memberId: string,
  from: LocalDate,
  to: LocalDate,
): Slot[] {
  const busy: Interval[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    busy.push(...unavailableOn(household, memberId, date));
  }
  return slotsBetweenDates(household, memberId, from, to).flatMap((slot) => cut(slot, busy));
}

/** 区間から、使えない時間を除いた残り（前と後に分かれることがある）。 */
function cut<T extends Interval>(piece: T, used: readonly Interval[]): T[] {
  let pieces = [piece];
  for (const u of used) {
    pieces = pieces.flatMap((p) =>
      u.end <= p.start || u.start >= p.end
        ? [p]
        : [
            ...(u.start > p.start ? [{ ...p, end: u.start }] : []),
            ...(u.end < p.end ? [{ ...p, start: u.end }] : []),
          ],
    );
  }
  return pieces;
}

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
 * 有効な大人の誰もが「家」以外の区間（通勤・仕事・迎え・外出）にいるか、手が離せない時間にあると書かれている時間の
 * 重なりを返す。「家」の区間だけを、子を見られる時間として数える（家で仕事をして見られない時は「仕事」と書く。画面
 * にも書く）。一日は家で始まり家で終わるとし、最初の区間の前と最後の区間の後は家にいるとする。区間の間の
 * 空きは、家の外とは決めない（分からない時間で、手配の要る時間を広げない）。朝だけ家にいて帰らない日や、
 * 一日中出かけている日は、その外の区間の全部が手配の要る時間になる（手配は黙って消えない）。その日の
 * 区間が無い大人は、分からないので数えず、ほかの大人だけで決める（手が離せない時間を足しても、分からない時間を
 * 見守れる時間とはしないので、手配の要る時間は縮まない）。どの大人にも区間が無い日は、だれかの手が離せない時間
 * だけを返す（見守れないと分かる大人がいて、見守れると分かる大人がいない時間）。何も記録が無ければ返さない。
 */
export function noAdultAtHome(household: Household, date: LocalDate): Interval[] {
  const adults = activeAdultIds(household).map((id) => ({
    slots: slotsOn(household, id, date),
    busy: unavailableOn(household, id, date),
  }));
  const away = adults
    .filter((a) => a.slots.length > 0)
    .map((a) => merged([...a.slots.filter((s) => s.kind !== 'home'), ...a.busy]));
  const [first, ...rest] = away;
  if (!first) return merged(adults.flatMap((a) => a.busy));
  return rest.reduce(intersected, first);
}
