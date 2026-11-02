// 日付と時刻。計画は分の精度で扱い、決まった刻みに丸めない（docs/design/01-model.md §8）。
// 日付だけの物は、その地の日付（LocalDate）として持つ。時刻は、時差付きの文字列（DateTime）か、
// 計算の中では紀元からの分（整数）で持つ。Node 24 には Temporal が無いので、polyfill を明示して使う。
import { Temporal } from 'temporal-polyfill';
import { z } from 'zod';
import { JP_HOLIDAYS, JP_HOLIDAYS_FIRST_DAY, JP_HOLIDAYS_LAST_DAY } from './holidays-jp';

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
// 秒は 00 だけ許す（分の精度）。時差は必須（UTC に直した時に日がずれないように）。
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:00)?[+-]\d{2}:\d{2}$/;

export function isValidLocalDate(value: string): boolean {
  if (!LOCAL_DATE.test(value)) return false;
  try {
    Temporal.PlainDate.from(value, { overflow: 'reject' });
    return true;
  } catch {
    return false;
  }
}

export function isValidDateTime(value: string): boolean {
  if (!DATE_TIME.test(value)) return false;
  try {
    Temporal.PlainDate.from(value.slice(0, 10), { overflow: 'reject' });
    Temporal.Instant.from(value);
    return true;
  } catch {
    return false;
  }
}

/** その地の日付（例：2026-12-07）。 */
export const LocalDate = z
  .string()
  .refine(isValidLocalDate, { error: '日付は YYYY-MM-DD の実在する日' });
export type LocalDate = z.infer<typeof LocalDate>;

/** その地の時刻（例：17:30）。 */
export const LocalTime = z.string().regex(LOCAL_TIME, { error: '時刻は HH:MM' });
export type LocalTime = z.infer<typeof LocalTime>;

/** 時差付きの時刻（例：2026-11-30T17:30+09:00）。 */
export const DateTime = z.string().refine(isValidDateTime, {
  error: '時刻は YYYY-MM-DDTHH:MM+09:00 の形（秒は 00 だけ）',
});
export type DateTime = z.infer<typeof DateTime>;

/** 曜日。ISO の番号で、月曜が 1、日曜が 7。 */
export const Weekday = z.number().int().min(1).max(7);
export type Weekday = z.infer<typeof Weekday>;

/** 紀元からの分。計画の計算はこの整数で行う。 */
export type EpochMinutes = number;

export function toEpochMinutes(value: DateTime): EpochMinutes {
  const ms = Temporal.Instant.from(value).epochMilliseconds;
  return Math.floor(ms / 60_000);
}

export function zonedToEpochMinutes(
  date: LocalDate,
  time: LocalTime,
  timeZone: string,
): EpochMinutes {
  const zoned = Temporal.PlainDateTime.from(`${date}T${time}`).toZonedDateTime(timeZone, {
    disambiguation: 'compatible',
  });
  return Math.floor(zoned.epochMilliseconds / 60_000);
}

function zonedOf(minutes: EpochMinutes, timeZone: string): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(minutes * 60_000).toZonedDateTimeISO(timeZone);
}

/** 分を時差付きの文字列にする（例：2026-11-30T17:30+09:00）。 */
export function formatDateTime(minutes: EpochMinutes, timeZone: string): DateTime {
  const zoned = zonedOf(minutes, timeZone);
  const date = zoned.toPlainDate().toString();
  const time = zoned.toPlainTime().toString({ smallestUnit: 'minute' });
  return `${date}T${time}${zoned.offset}`;
}

export function localDateOf(minutes: EpochMinutes, timeZone: string): LocalDate {
  return zonedOf(minutes, timeZone).toPlainDate().toString();
}

export function localTimeOf(minutes: EpochMinutes, timeZone: string): LocalTime {
  return zonedOf(minutes, timeZone).toPlainTime().toString({ smallestUnit: 'minute' });
}

export function weekdayOf(date: LocalDate): Weekday {
  return Temporal.PlainDate.from(date).dayOfWeek;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return Temporal.PlainDate.from(date).add({ days }).toString();
}

/** 分の差（b − a）。 */
export function minutesBetween(a: DateTime, b: DateTime): number {
  return toEpochMinutes(b) - toEpochMinutes(a);
}

/** 祝日のデータの範囲の外の日を問うた時に投げる。呼ぶ側は「まだ判断できない」にする。 */
export class HolidayDataOutOfRange extends Error {
  constructor(readonly date: LocalDate) {
    super(`祝日のデータの範囲の外：${date}（${JP_HOLIDAYS_FIRST_DAY}〜${JP_HOLIDAYS_LAST_DAY}）`);
  }
}

export function isHolidayKnown(date: LocalDate): boolean {
  return date >= JP_HOLIDAYS_FIRST_DAY && date <= JP_HOLIDAYS_LAST_DAY;
}

/** 日本の国民の祝日・休日の名前。祝日でなければ undefined。範囲の外なら投げる。 */
export function japaneseHolidayName(date: LocalDate): string | undefined {
  if (!isHolidayKnown(date)) throw new HolidayDataOutOfRange(date);
  return JP_HOLIDAYS.get(date);
}

export interface BusinessCalendar {
  /** 土日・祝日のほかに休む日（勤務先の休み等）。 */
  closedDates?: ReadonlySet<LocalDate>;
}

export function isBusinessDay(date: LocalDate, calendar: BusinessCalendar = {}): boolean {
  const weekday = weekdayOf(date);
  if (weekday === 6 || weekday === 7) return false;
  if (japaneseHolidayName(date) !== undefined) return false;
  return !calendar.closedDates?.has(date);
}

/** 営業日を足す・引く。始まりの日は数えない（例：12/7 から −3 営業日は 12/2）。 */
export function addBusinessDays(
  date: LocalDate,
  amount: number,
  calendar: BusinessCalendar = {},
): LocalDate {
  if (!Number.isInteger(amount)) throw new Error('営業日の数は整数');
  let current = date;
  let left = Math.abs(amount);
  const step = Math.sign(amount);
  while (left > 0) {
    current = addDays(current, step);
    if (isBusinessDay(current, calendar)) left -= 1;
  }
  return current;
}
