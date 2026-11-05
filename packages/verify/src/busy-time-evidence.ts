// 記録された占用と作業の時間を、予定を置くコードに依らず照らす。
import { LocalDate } from '@maniau/core';
import { dateIndex, type Interval, localMinute, overlaps, timeOfDay } from './time';
import type { RecordedUnavailable } from './unavailable-evidence';

export interface BusyTimeEvidence {
  /** 家庭の時区の日付と時刻を分にした区間。作業と明示の占用の重なりだけ。 */
  conflicts: Interval[];
  /** 窓・時区・その人の記録に、独立に照らせない所がある。 */
  incomplete: boolean;
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 開始・終了は実際の時刻の分。呼び手が作業と前後の移動を含める。
 * 何も記録されていない時は空きを証明しない（明示の衝突が見つからなかっただけ）。
 */
export function recordedBusyTimeEvidence(
  unavailable: readonly RecordedUnavailable[],
  memberId: string,
  start: number,
  end: number,
  timeZone: string,
): BusyTimeEvidence {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end)
    return { conflicts: [], incomplete: true };
  let localStart: ReturnType<typeof localMinute>;
  let localEnd: ReturnType<typeof localMinute>;
  try {
    localStart = localMinute(start, timeZone);
    localEnd = localMinute(end, timeZone);
  } catch {
    return { conflicts: [], incomplete: true };
  }
  // 時差が途中で変わる範囲は、同じ局所分だけでは正しく照らせない。
  if (localEnd.localIndex - localStart.localIndex !== end - start)
    return { conflicts: [], incomplete: true };
  let incomplete = false;
  const conflicts: Interval[] = [];
  const task = { start: localStart.localIndex, end: localEnd.localIndex };
  for (const entry of unavailable) {
    if (entry.memberId !== memberId) continue;
    if (
      !LocalDate.safeParse(entry.date).success ||
      !CLOCK.test(entry.start) ||
      !CLOCK.test(entry.end)
    ) {
      incomplete = true;
      continue;
    }
    const day = dateIndex(entry.date);
    const busy = { start: day + timeOfDay(entry.start), end: day + timeOfDay(entry.end) };
    if (busy.start >= busy.end) {
      incomplete = true;
      continue;
    }
    if (overlaps(task, busy))
      conflicts.push({
        start: Math.max(task.start, busy.start),
        end: Math.min(task.end, busy.end),
      });
  }
  return { conflicts, incomplete };
}
