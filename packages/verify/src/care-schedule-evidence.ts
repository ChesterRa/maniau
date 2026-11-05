// 一日の確認済み日程を、求解のコードを使わず見守りの根拠に直す。
import { readClockIntervals } from './care-day-evidence';
import type { CarePersonEvidence } from './care-knowledge';

export interface CareScheduleSegment {
  start: string;
  end: string;
  kind: 'home' | 'commute' | 'work' | 'pickup' | 'away';
}

/**
 * 呼出側が、当日例外／週間のどちらが有効か、全日の前後を家とする根拠があるかを確かめてから使う。
 * 区間の間に記録されていない時間は、この部品では家にも外にも決めない。
 */
export function recordedCareSchedule(
  memberId: string,
  segments: readonly CareScheduleSegment[],
  busyRows: readonly { start: string; end: string }[] = [],
): CarePersonEvidence | undefined {
  if (!memberId) return undefined;
  const days = readClockIntervals(segments);
  const busy = readClockIntervals(busyRows);
  if (!days || !busy) return undefined;
  if (segments.some((s) => !['home', 'commute', 'work', 'pickup', 'away'].includes(s.kind))) {
    return undefined;
  }
  const outside = readClockIntervals(segments.filter((segment) => segment.kind !== 'home'));
  if (!outside) return undefined;
  const first = days[0];
  const last = days.at(-1);
  if (!first || !last) return { id: memberId, known: [], unavailable: busy };
  return {
    id: memberId,
    known: [
      ...(first.start > 0 ? [{ start: 0, end: first.start }] : []),
      ...days,
      ...(last.end < 24 * 60 ? [{ start: last.end, end: 24 * 60 }] : []),
    ],
    unavailable: [...outside, ...busy],
  };
}
