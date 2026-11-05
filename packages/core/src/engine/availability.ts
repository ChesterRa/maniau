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

/** 子の見守りの、その日の分かり方（careCoverage）。時刻は紀元からの分、早い順に並べて一つにした物。 */
export interface CareCoverage {
  /** 大人の全員が見られないと分かっている時間（子の居場所の手配が要る時間）。 */
  certain: Interval[];
  /** 見られる大人がいるとも、全員が見られないとも分からない時間（答えるまで、どちらにも数えない）。 */
  unsure: Interval[];
  /** unsure の時間に、分からない時間がある大人（成員の順）。 */
  missing: string[];
}

/**
 * その日（その日の 0 時から次の日の 0 時まで）、子を見られる大人がいるかの分かり方。大人ごとに、見られる時間
 * （can）・見られない時間（cannot）・分からない時間を決め、全員が見られない時間を certain、見られる大人がいない
 * のに全員が見られないとも言えない時間を unsure にする。
 * - その日の答え（dayAnswers）がある大人：答えのとおり（区間より先）。
 * - その日の区間（ふだんの週・その日だけの一日）がある大人：区間で一日が分かる。「家」の区間と、最初の区間の前・最後の
 *   区間の後（家にいるとする、今までの決まり）を見られる時間に数え（家で仕事をして見られない時は「仕事」と書く）、
 *   家以外の区間を見られない時間にする。区間の間の空き（前からの記録にだけあり得る。新しい記録はサーバーが断る）は
 *   分からない（家の外とも、見られるとも決めない）。
 * - どちらも無い大人：分からない（不在にも、見られるにも数えない）。
 * どの大人でも、手が離せない時間は見られない時間に入る。大人の全員に区間がある前からの家庭では、certain は
 * 前の計算（区間のある大人の、家の外の時間の重なり）と同じで、unsure は無い。
 */
export function careCoverage(household: Household, date: LocalDate): CareCoverage {
  const tz = household.timeZone;
  const day: Interval[] = [
    {
      start: zonedToEpochMinutes(date, '00:00', tz),
      end: zonedToEpochMinutes(addDays(date, 1), '00:00', tz),
    },
  ];
  const span = (s: { start: string; end: string }): Interval => ({
    start: zonedToEpochMinutes(date, s.start, tz),
    end: zonedToEpochMinutes(date, s.end, tz),
  });
  const adults = activeAdultIds(household).map((id) => {
    const busy = unavailableOn(household, id, date);
    const answer = household.dayAnswers?.find((a) => a.memberId === id && a.date === date);
    if (answer) {
      const said = merged([...answer.can, ...answer.cannot].map(span));
      const rest = subtract(day, said);
      const can = merged([...answer.can.map(span), ...(answer.rest === 'can' ? rest : [])]);
      const cannot = merged([
        ...answer.cannot.map(span),
        ...(answer.rest === 'cannot' ? rest : []),
        ...busy,
      ]);
      return { id, can: subtract(can, cannot), cannot };
    }
    const slots = slotsOn(household, id, date);
    if (slots.length > 0) {
      const away = merged([...slots.filter((s) => s.kind !== 'home'), ...busy]);
      const first = Math.min(...slots.map((s) => s.start));
      const last = Math.max(...slots.map((s) => s.end));
      const home = merged(
        [
          ...slots.filter((s) => s.kind === 'home'),
          { start: day[0]?.start ?? first, end: first },
          { start: last, end: day[0]?.end ?? last },
        ].filter((s) => s.start < s.end),
      );
      return { id, can: subtract(home, away), cannot: away };
    }
    return { id, can: [] as Interval[], cannot: busy };
  });
  const [first, ...rest] = adults.map((a) => a.cannot);
  const certain = first ? rest.reduce(intersected, first) : [];
  const covered = merged(adults.flatMap((a) => a.can));
  const unsure = subtract(subtract(day, covered), certain);
  const missing = adults
    .filter((a) => {
      const unknown = subtract(subtract(day, a.can), a.cannot);
      return intersected(unknown, unsure).length > 0;
    })
    .map((a) => a.id);
  return { certain, unsure, missing };
}

/** 大人の全員が見られないと分かっている時間（careCoverage の certain。子の居場所の手配が要る時間）。 */
export function noAdultAtHome(household: Household, date: LocalDate): Interval[] {
  return careCoverage(household, date).certain;
}

/** 並べて一つにした区間の列から、別の列の時間を除いた残り（早い順）。 */
function subtract(from: readonly Interval[], used: readonly Interval[]): Interval[] {
  return merged(from.flatMap((piece) => cut(piece, used)));
}
