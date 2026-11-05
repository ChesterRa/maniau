// 見守りの根拠を時間ごとに照らす小さい部品。家庭の事象からこれを作る口は別にする。
// 求解のコードを使わない。数は対象日の 0 時からの分、区間は半開 [start,end)。
import type { Interval } from './time';

/**
 * known は、その人の予定が確認された範囲。unavailable は、確認された「見守れない」範囲。
 * unavailable は known の外にも置け、その部分だけを見守れない事実として使う。
 * known の外を家・不在に埋めるかは、この部品では決めない（元の記録を読む口が根拠と共に渡す）。
 */
export interface CarePersonEvidence {
  id: string;
  known: readonly Interval[];
  unavailable: readonly Interval[];
}

export interface CareKnowledge {
  /** 全員が見守れないと確認できた時間。 */
  certain: Interval[];
  /** 見守れる人を確認できていない時間（確かな空きと未知の両方を含む）。 */
  possible: Interval[];
  /** 未知が結果を変えうる時間と、その時間に未確認の人。 */
  missing: (Interval & { adults: string[] })[];
  /** 結果を変えうる人（家庭に渡された順）。 */
  missingAdults: string[];
}

function validInterval(value: Interval): boolean {
  return (
    Number.isInteger(value.start) &&
    Number.isInteger(value.end) &&
    value.start >= 0 &&
    value.start < value.end &&
    value.end <= 24 * 60
  );
}

function contains(intervals: readonly Interval[], start: number, end: number): boolean {
  return intervals.some((interval) => interval.start <= start && end <= interval.end);
}

function append(intervals: Interval[], start: number, end: number): void {
  const previous = intervals.at(-1);
  if (previous?.end === start) previous.end = end;
  else intervals.push({ start, end });
}

/** 事実が読めない時は undefined。無効な根拠から「見守れない」や「空き無し」と決めない。 */
export function careKnowledge(adults: readonly CarePersonEvidence[]): CareKnowledge | undefined {
  if (
    adults.length === 0 ||
    new Set(adults.map((adult) => adult.id)).size !== adults.length ||
    adults.some(
      (adult) =>
        !adult.id ||
        [...adult.known, ...adult.unavailable].some((interval) => !validInterval(interval)),
    )
  )
    return undefined;

  const points = [
    ...new Set([
      0,
      24 * 60,
      ...adults.flatMap((adult) =>
        [...adult.known, ...adult.unavailable].flatMap((interval) => [
          interval.start,
          interval.end,
        ]),
      ),
    ]),
  ].sort((a, b) => a - b);
  const certain: Interval[] = [];
  const possible: Interval[] = [];
  const missing: CareKnowledge['missing'] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i];
    const end = points[i + 1];
    if (start === undefined || end === undefined || start >= end) continue;
    const states = adults.map((adult) => ({
      id: adult.id,
      state: contains(adult.unavailable, start, end)
        ? 'cannot'
        : contains(adult.known, start, end)
          ? 'can'
          : 'unknown',
    }));
    if (states.every((person) => person.state === 'cannot')) append(certain, start, end);
    if (states.some((person) => person.state === 'can')) continue;
    append(possible, start, end);
    const unknown = states
      .filter((person) => person.state === 'unknown')
      .map((person) => person.id);
    if (unknown.length === 0) continue;
    const previous = missing.at(-1);
    if (previous?.end === start && JSON.stringify(previous.adults) === JSON.stringify(unknown)) {
      previous.end = end;
    } else missing.push({ start, end, adults: unknown });
  }
  const relevant = new Set(missing.flatMap((interval) => interval.adults));
  return {
    certain,
    possible,
    missing,
    missingAdults: adults.filter((a) => relevant.has(a.id)).map((a) => a.id),
  };
}
