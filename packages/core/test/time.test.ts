import { describe, expect, it } from 'vitest';
import {
  addBusinessDays,
  DateTime,
  formatDateTime,
  HolidayDataOutOfRange,
  isBusinessDay,
  japaneseHolidayName,
  LocalDate,
  localDateOf,
  toEpochMinutes,
  weekdayOf,
  zonedToEpochMinutes,
} from '../src/time';

const TOKYO = 'Asia/Tokyo';

describe('日付と曜日', () => {
  it('デモの日付の曜日が合う', () => {
    expect(weekdayOf('2026-11-25')).toBe(3); // 水
    expect(weekdayOf('2026-11-30')).toBe(1); // 月
    expect(weekdayOf('2026-12-05')).toBe(6); // 土
    expect(weekdayOf('2026-12-07')).toBe(1); // 月
    expect(weekdayOf('2026-12-08')).toBe(2); // 火
  });

  it('実在しない日付と時刻を受け付けない', () => {
    expect(LocalDate.safeParse('2026-02-30').success).toBe(false);
    expect(LocalDate.safeParse('2026-12-07').success).toBe(true);
    expect(DateTime.safeParse('2026-11-30T17:30+09:00').success).toBe(true);
    expect(DateTime.safeParse('2026-11-30T17:30:00+09:00').success).toBe(true);
    expect(DateTime.safeParse('2026-11-30T17:30:15+09:00').success).toBe(false);
    expect(DateTime.safeParse('2026-11-30T24:00+09:00').success).toBe(false);
    expect(DateTime.safeParse('2026-11-30T17:30').success).toBe(false);
  });
});

describe('時差と分', () => {
  it('日本時間の時刻を分にし、同じ文字列に戻す', () => {
    const minutes = zonedToEpochMinutes('2026-11-30', '17:30', TOKYO);
    expect(minutes).toBe(toEpochMinutes('2026-11-30T17:30+09:00'));
    expect(formatDateTime(minutes, TOKYO)).toBe('2026-11-30T17:30+09:00');
    expect(formatDateTime(minutes - 10, TOKYO)).toBe('2026-11-30T17:20+09:00');
  });

  it('深夜の時刻を UTC に直しても、日本の日付を保つ', () => {
    const minutes = toEpochMinutes('2026-12-07T00:30+09:00');
    expect(localDateOf(minutes, TOKYO)).toBe('2026-12-07');
  });
});

describe('祝日と営業日', () => {
  it('内閣府のデータの祝日を知っている', () => {
    expect(japaneseHolidayName('2026-11-03')).toBe('文化の日');
    expect(japaneseHolidayName('2026-11-23')).toBe('勤労感謝の日');
    expect(japaneseHolidayName('2026-12-07')).toBeUndefined();
  });

  it('範囲の外は分からないとして投げる', () => {
    expect(() => japaneseHolidayName('2028-01-01')).toThrow(HolidayDataOutOfRange);
  });

  it('有休の締切：12/7(月)の3営業日前は 12/2(水)、12/8(火)の3営業日前は 12/3(木)', () => {
    expect(addBusinessDays('2026-12-07', -3)).toBe('2026-12-02');
    expect(addBusinessDays('2026-12-08', -3)).toBe('2026-12-03');
  });

  it('祝日と週末を飛ばす', () => {
    expect(addBusinessDays('2026-11-20', 1)).toBe('2026-11-24');
    expect(isBusinessDay('2026-11-23')).toBe(false);
    expect(isBusinessDay('2026-11-24', { closedDates: new Set(['2026-11-24']) })).toBe(false);
  });
});
