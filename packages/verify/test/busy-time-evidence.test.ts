import { describe, expect, it } from 'vitest';
import { recordedBusyTimeEvidence } from '../src/busy-time-evidence';
import { dateIndex } from '../src/time';

const instant = (value: string) => Date.parse(value) / 60_000;
const entry = (memberId: string, date: string, start: string, end: string) => ({
  id: `${memberId}-${date}-${start}`,
  memberId,
  date,
  start,
  end,
});
const local = (date: string, hour: number, minute = 0) => dateIndex(date) + hour * 60 + minute;

describe('作業と明示された占用の独立な重なり', () => {
  it('前後の移動を含む時刻の、実際に重なった部分を返す', () => {
    const result = recordedBusyTimeEvidence(
      [entry('a', '2026-12-07', '09:00', '10:00')],
      'a',
      instant('2026-12-07T08:50+09:00'),
      instant('2026-12-07T09:05+09:00'),
      'Asia/Tokyo',
    );
    expect(result).toEqual({
      conflicts: [{ start: local('2026-12-07', 9), end: local('2026-12-07', 9, 5) }],
      incomplete: false,
    });
  });

  it('端の接触と別人・別日の占用は重ならない', () => {
    const result = recordedBusyTimeEvidence(
      [
        entry('a', '2026-12-07', '09:00', '10:00'),
        entry('b', '2026-12-07', '08:00', '10:00'),
        entry('a', '2026-12-08', '08:00', '10:00'),
      ],
      'a',
      instant('2026-12-07T08:00+09:00'),
      instant('2026-12-07T09:00+09:00'),
      'Asia/Tokyo',
    );
    expect(result).toEqual({ conflicts: [], incomplete: false });
  });

  it('作業が日をまたぐ時、翌日の占用も落とさない', () => {
    const result = recordedBusyTimeEvidence(
      [entry('a', '2026-12-08', '00:00', '01:00')],
      'a',
      instant('2026-12-07T23:55+09:00'),
      instant('2026-12-08T00:05+09:00'),
      'Asia/Tokyo',
    );
    expect(result).toEqual({
      conflicts: [{ start: local('2026-12-08', 0), end: local('2026-12-08', 0, 5) }],
      incomplete: false,
    });
  });

  it('同じ瞬間は時差表記が違っても同じように照らす', () => {
    const inputs = [entry('a', '2026-12-07', '09:00', '10:00')];
    const japan = recordedBusyTimeEvidence(
      inputs,
      'a',
      instant('2026-12-07T09:30+09:00'),
      instant('2026-12-07T10:30+09:00'),
      'Asia/Tokyo',
    );
    const utc = recordedBusyTimeEvidence(
      inputs,
      'a',
      instant('2026-12-07T00:30+00:00'),
      instant('2026-12-07T01:30+00:00'),
      'Asia/Tokyo',
    );
    expect(japan).toEqual(utc);
    expect(japan.conflicts).toEqual([
      { start: local('2026-12-07', 9, 30), end: local('2026-12-07', 10) },
    ]);
  });

  it('不正な時間と時区を見落とさず、衝突なしとも断定しない', () => {
    const start = instant('2026-12-07T09:00+09:00');
    const end = instant('2026-12-07T10:00+09:00');
    for (const row of [
      entry('a', '2026-12-07', '09:99', '10:00'),
      entry('a', '2026-12-07', '10:00', '09:00'),
      entry('a', '2026-13-01', '09:00', '10:00'),
    ]) {
      expect(recordedBusyTimeEvidence([row], 'a', start, end, 'Asia/Tokyo').incomplete).toBe(true);
    }
    expect(recordedBusyTimeEvidence([], 'a', start, end, 'No/Such_Zone').incomplete).toBe(true);
  });
});
