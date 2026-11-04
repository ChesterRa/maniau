// その日だけの一日の下書き：ある大人のある日を、今のその日（その日だけの一日があればそれ、無ければふだんの曜日の
// 一日）から作る。区間はモデルに書かせず、ここで作る（一言の読み取りは、休む・その時間は家・外出・遅くなるの種類と、
// 言われた時刻だけを返す）。作れない時は、計算せずに理由を返す（推し量らない）。
import type { Household, RoutineSegment } from '../schema/household';
import { type LocalDate, weekdayOf } from '../time';

/**
 * 一日の変え方。off：一日家にいる。home：その時間だけ家にいる（子を見られる時間として数える）。away：その時間だけ
 * 家の外（行き先と行き来の時間は、その時間に含める）。late：仕事の終わる時刻が変わる（遅くなる・早く上がる）。home
 * と away は同じ形（その時間の区間を、家か外出に置き替える）。
 */
export type DayChange =
  | { change: 'off' }
  | { change: 'home' | 'away'; from: string; to: string }
  | { change: 'late'; to: string };

/**
 * 作れない訳。noDay：その日の区間が無い。noHome：家の場所が無い。badTime：時刻が HH:MM でない・始まりが終わりより
 * 前でない。outsideDay：その時間がその日の区間とつながらない。travel：その時間だけ家にすると、職場・迎えの場所との
 * 行き来の時間が分からない（瞬間に場所を移る一日を作らない）。noWork：仕事の区間が無い。pickup：仕事の終わりを
 * 変える日の仕事の後に迎えがある（迎えの時刻をどうするかは、言われていないので決めない）。afterWork：仕事の後が
 * 「家までの通勤 → 家」でない、または帰り道が後の予定（外出など）に届く（その予定をどうするか言われていない）。
 * overnight：日をまたぐ。
 */
export type DayDraftProblem =
  | 'noDay'
  | 'noHome'
  | 'badTime'
  | 'outsideDay'
  | 'travel'
  | 'noWork'
  | 'pickup'
  | 'afterWork'
  | 'overnight';

export type DayDraft =
  | {
      ok: true;
      segments: RoutineSegment[];
      /** 下書きの元：その日だけの一日（もう記録してある）か、ふだんの曜日の一日か。 */
      base: 'exception' | 'routine';
    }
  | { ok: false; problem: DayDraftProblem };

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const clock = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** その人のその日の、今の区間（その日だけの一日があればそれ）。 */
export function dayOf(
  household: Household,
  memberId: string,
  date: LocalDate,
): { segments: RoutineSegment[]; base: 'exception' | 'routine' } | undefined {
  const exception = household.routineExceptions.find(
    (e) => e.memberId === memberId && e.date === date,
  );
  if (exception) return { segments: exception.segments, base: 'exception' };
  const weekday = weekdayOf(date);
  const routine = household.routines.find((r) => r.memberId === memberId && r.weekday === weekday);
  return routine?.segments.length ? { segments: routine.segments, base: 'routine' } : undefined;
}

/** その人のその日を、言われた変え方で作り直す（元の区間は変えない）。 */
export function draftDay(
  household: Household,
  memberId: string,
  date: LocalDate,
  change: DayChange,
): DayDraft {
  const day = dayOf(household, memberId, date);
  if (!day) return { ok: false, problem: 'noDay' };
  const home = household.places.find((p) => p.kind === 'home')?.id;
  if (!home) return { ok: false, problem: 'noHome' };
  const segments = day.segments.map((s) => ({ ...s, viaStationIds: [...s.viaStationIds] }));
  const first = segments[0];
  const last = segments.at(-1);
  if (!first || !last) return { ok: false, problem: 'noDay' };
  const done = (out: RoutineSegment[]): DayDraft => ({ ok: true, segments: out, base: day.base });

  if (change.change === 'off') {
    // 仕事・通勤・外出・迎えを家に替え、その日の始まりから終わりまで一つの家の区間にする。
    return done([
      { start: first.start, end: last.end, kind: 'home', placeId: home, viaStationIds: [] },
    ]);
  }

  if (change.change === 'home' || change.change === 'away') {
    if (!TIME.test(change.from) || !TIME.test(change.to) || change.from >= change.to) {
      return { ok: false, problem: 'badTime' };
    }
    // その時間がその日の区間とつながらない（前や後ろに離れている）時は作らない（書かれていない時間を作らない）。
    if (change.to < first.start || change.from > last.end)
      return { ok: false, problem: 'outsideDay' };
    const out: RoutineSegment[] = [];
    for (const s of segments) {
      if (s.end <= change.from || s.start >= change.to) {
        out.push(s);
        continue;
      }
      // 家にいる時間が通勤の途中で始まる・終わる時は、行き来の時間が分からない（途中で家に移れない）。通勤の全部を
      // 覆う時は、その通勤をしない（家にいる）。
      if (
        change.change === 'home' &&
        s.kind === 'commute' &&
        (s.start < change.from || s.end > change.to)
      ) {
        return { ok: false, problem: 'travel' };
      }
      // 重なる区間は、重ならない前と後ろだけを残す（前後はふだんどおり）。
      if (s.start < change.from) out.push({ ...s, end: change.from });
      if (s.end > change.to) out.push({ ...s, start: change.to });
    }
    if (change.change === 'home') {
      // 家の時間の前と後ろが、職場・迎えの場所や、家と結ばない通勤なら、行き来の時間が分からない。
      const before = out.filter((x) => x.end <= change.from).at(-1);
      const after = out.find((x) => x.start >= change.to);
      const away = (x: RoutineSegment | undefined, end: 'from' | 'to') =>
        x !== undefined &&
        (x.kind === 'work' ||
          x.kind === 'pickup' ||
          (x.kind === 'commute' && (end === 'to' ? x.toId : x.fromId) !== home));
      if (away(before, 'to') || away(after, 'from')) return { ok: false, problem: 'travel' };
    }
    out.push(
      change.change === 'home'
        ? { start: change.from, end: change.to, kind: 'home', placeId: home, viaStationIds: [] }
        : { start: change.from, end: change.to, kind: 'away', viaStationIds: [] },
    );
    out.sort((a, b) => minutes(a.start) - minutes(b.start));
    // 隣り合う同じ家の区間は一つにまとめる（見せる時に区切りを増やさない）。
    const merged: RoutineSegment[] = [];
    for (const s of out) {
      const previous = merged.at(-1);
      if (
        previous &&
        previous.kind === 'home' &&
        s.kind === 'home' &&
        previous.placeId === s.placeId &&
        previous.end === s.start
      ) {
        previous.end = s.end;
      } else merged.push({ ...s });
    }
    return done(merged);
  }

  // late：最後の仕事の終わる時刻を変え、仕事のすぐ後の帰り道（家に着くまでの通勤）だけを、同じ長さのまま前か後ろへ
  // ずらす。家に着いた後の家の区間は、終わりをそのまま残して始まりだけ動かし、その後の予定（外出など）は動かさない。
  if (!TIME.test(change.to)) return { ok: false, problem: 'badTime' };
  const workIndex = segments.findLastIndex((s) => s.kind === 'work');
  const work = segments[workIndex];
  if (!work) return { ok: false, problem: 'noWork' };
  if (change.to <= work.start) return { ok: false, problem: 'badTime' };
  if (change.to === work.end) return done(segments);
  const after = segments.slice(workIndex + 1);
  const shift = minutes(change.to) - minutes(work.end);
  // 仕事の後に迎えがあれば、迎えの時刻をどうするか（遅れて行く・だれかが代わる・早く迎える・待つ）は言われていない
  // ので、ずらさずに計算しない（家族に、ふだんの週か「一日休み」で直してもらう）。
  if (after.some((s) => s.kind === 'pickup')) return { ok: false, problem: 'pickup' };
  const tripEnd = after.findIndex((s) => s.kind !== 'commute');
  const trip = after.slice(0, tripEnd < 0 ? after.length : tripEnd);
  const arrival = tripEnd < 0 ? undefined : after[tripEnd];
  const rest = tripEnd < 0 ? [] : after.slice(tripEnd + 1);
  // 仕事の後が「家までの通勤 → 家」（家で仕事をする日は、すぐ家）でなければ（すぐ外出・別の場所へ行く等）、その予定を
  // どうするか分からない。
  const reachesHome = trip.length === 0 ? work.placeId === home : trip.at(-1)?.toId === home;
  if (!reachesHome || arrival?.kind !== 'home') return { ok: false, problem: 'afterWork' };
  const out = segments.slice(0, workIndex);
  out.push({ ...work, end: change.to });
  for (const s of trip) {
    const start = minutes(s.start) + shift;
    const end = minutes(s.end) + shift;
    if (end > minutes('23:59')) return { ok: false, problem: 'overnight' };
    out.push({ ...s, start: clock(start), end: clock(end) });
  }
  const homeAt = minutes(arrival.start) + shift;
  if (rest.length > 0) {
    // 家に着くのが、次の予定（外出など）の始まりに届くなら、その予定をどうするか分からない。
    if (homeAt >= minutes(arrival.end)) return { ok: false, problem: 'afterWork' };
    out.push({ ...arrival, start: clock(homeAt) }, ...rest);
    return done(out);
  }
  // その日の最後の家の区間は、終わりをその日の終わりのまま残す（着くのが終わりに届く時は、その日の 23:59 まで）。
  const lastEnd = homeAt < minutes(arrival.end) ? minutes(arrival.end) : minutes('23:59');
  if (homeAt >= lastEnd) return { ok: false, problem: 'overnight' };
  out.push({ ...arrival, start: clock(homeAt), end: clock(lastEnd) });
  return done(out);
}
