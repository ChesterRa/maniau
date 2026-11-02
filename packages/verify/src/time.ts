// 計画エンジンと別に、標準の日時機能を使って時刻と曜日を照合する。
const MINUTES_PER_DAY = 24 * 60;

export interface LocalMinute {
  date: string;
  minuteOfDay: number;
  /** 地域の日付・時刻を比較するための分。東京には夏時間がない。 */
  localIndex: number;
}

export function instantMinute(value: string): number {
  return Date.parse(value) / 60_000;
}

export function timeOfDay(value: string): number {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

export function dateIndex(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / 60_000;
}

export function dateFromIndex(index: number): string {
  return new Date(index * 60_000).toISOString().slice(0, 10);
}

export function weekday(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

export function localMinute(instant: number, timeZone: string): LocalMinute {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant * 60_000));
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  const date = `${value('year')}-${value('month')}-${value('day')}`;
  const minuteOfDay = Number(value('hour')) * 60 + Number(value('minute'));
  return { date, minuteOfDay, localIndex: dateIndex(date) + minuteOfDay };
}

export interface Interval {
  start: number;
  end: number;
}

/** 終点どうしの接触は重なりではない。 */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < a.end && b.start < b.end && a.start < b.end && b.start < a.end;
}

/** 同じ条件の隣り合う区間を結んでも、空いた穴を埋めない。 */
export function coveredBy(start: number, end: number, intervals: readonly Interval[]): boolean {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = start;
  for (const interval of sorted) {
    if (interval.end < cursor) continue;
    if (interval.start > cursor) return false;
    cursor = Math.max(cursor, interval.end);
    if (cursor >= end) return true;
  }
  return false;
}

export function dayStarts(start: number, end: number): number[] | undefined {
  const first = Math.floor(start / MINUTES_PER_DAY) * MINUTES_PER_DAY;
  const last = Math.floor((end > start ? end - 1 : end) / MINUTES_PER_DAY) * MINUTES_PER_DAY;
  // 長い作業を有限の検証で黙って打ち切らない。
  if ((last - first) / MINUTES_PER_DAY > 31) return undefined;
  const days: number[] = [];
  for (let day = first; day <= last; day += MINUTES_PER_DAY) days.push(day);
  return days;
}
