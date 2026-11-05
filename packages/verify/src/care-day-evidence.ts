// 一日の見守りについて、家族が記録した区間と「それ以外」の意味を独立に読む。
// 事象から最新の回答を選ぶ・家庭の参照を照らす処理は、この部品の外で行う。
import type { CarePersonEvidence } from './care-knowledge';
import type { Interval } from './time';

export interface RecordedCareDay {
  memberId: string;
  can: readonly { start: string; end: string }[];
  cannot: readonly { start: string; end: string }[];
  rest: 'can' | 'cannot' | 'unknown';
}

function minute(value: string): number | undefined {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return undefined;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

export function readClockIntervals(
  rows: readonly { start: string; end: string }[],
): Interval[] | undefined {
  const parsed: Interval[] = [];
  for (const row of rows) {
    const start = minute(row.start);
    const end = minute(row.end);
    if (start === undefined || end === undefined || start >= end) return undefined;
    parsed.push({ start, end });
  }
  parsed.sort((a, b) => a.start - b.start || a.end - b.end);
  if (parsed.some((entry, i) => i > 0 && (parsed[i - 1]?.end ?? 0) > entry.start)) return undefined;
  return parsed;
}

function complement(covered: readonly Interval[]): Interval[] {
  const missing: Interval[] = [];
  let start = 0;
  for (const range of covered) {
    if (start < range.start) missing.push({ start, end: range.start });
    start = range.end;
  }
  if (start < 24 * 60) missing.push({ start, end: 24 * 60 });
  return missing;
}

/**
 * 回答と明示の「手が離せない」を照らす。同じ時間を can と cannot の双方に書いた回答は解釈しない。
 * 忙しさは、確認できない時間も含め、そこだけを「見守れない」にする。
 */
export function recordedCareDay(
  day: RecordedCareDay,
  busyRows: readonly { start: string; end: string }[] = [],
): CarePersonEvidence | undefined {
  if (!day.memberId || !['can', 'cannot', 'unknown'].includes(day.rest)) return undefined;
  const can = readClockIntervals(day.can);
  const cannot = readClockIntervals(day.cannot);
  const busy = readClockIntervals(busyRows);
  if (!can || !cannot || !busy) return undefined;
  if (can.some((a) => cannot.some((b) => a.start < b.end && b.start < a.end))) return undefined;
  const allDay = [{ start: 0, end: 24 * 60 }];
  return {
    id: day.memberId,
    known: day.rest === 'unknown' ? can : allDay,
    unavailable: [...(day.rest === 'cannot' ? complement(can) : cannot), ...busy],
  };
}
