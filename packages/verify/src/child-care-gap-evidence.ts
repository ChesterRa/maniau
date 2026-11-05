// 求解のコードを使わず、家庭に記録された時間から子の居場所の空きを照らす。
import type { Household } from '@maniau/core';
import { routinesOn } from './routine';
import { type Interval, timeOfDay } from './time';

/** 記録から製品が計算する空き。実際に大人がいないという証明ではない。 */
export interface ModeledCareGaps {
  gaps: Interval[];
  /** 日程の重複や不正があり、どの記録から計算したか決められない時は false。 */
  complete: boolean;
}

export interface CareSplitClaim {
  /** splitGaps の一条に入った区間。印そのものが無い場合は undefined。 */
  reported?: readonly Interval[];
  /** 依頼や作業が対象とする一つの窓。 */
  window: Interval;
  recommended: boolean;
}

export interface CareSplitCheck {
  violations: ('missing' | 'mismatch' | 'window' | 'recommended')[];
  undetermined: boolean;
}

type Segment = Interval & { away: boolean };

function readSegments(
  household: Household,
  memberId: string,
  date: string,
): {
  segments: Segment[];
  hasDay: boolean;
  complete: boolean;
} {
  const days = routinesOn(household, memberId, date);
  if (days.length > 1) return { segments: [], hasDay: false, complete: false };
  const segments = (days[0]?.segments ?? [])
    .map((segment) => ({
      start: timeOfDay(segment.start),
      end: timeOfDay(segment.end),
      away: segment.kind !== 'home',
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const invalid = segments.some(
    (segment, i) =>
      !Number.isFinite(segment.start) ||
      !Number.isFinite(segment.end) ||
      segment.start < 0 ||
      segment.end > 24 * 60 ||
      segment.start >= segment.end ||
      (i > 0 && (segments[i - 1]?.end ?? 0) > segment.start),
  );
  return { segments, hasDay: segments.length > 0, complete: !invalid };
}

function add(output: Interval[], start: number, end: number): void {
  const previous = output.at(-1);
  if (previous?.end === start) previous.end = end;
  else output.push({ start, end });
}

/**
 * 区間の端で一日を区切って照らす。一日の記録がある大人は、区間の外を従来どおり家とする。
 * 一日が無い大人は不明。家と扱う人がおらず、記録上見られない人が一人以上いる時を空きとする。
 */
export function modeledCareGaps(household: Household, date: string): ModeledCareGaps {
  const adults = household.members.filter((member) => member.kind === 'adult' && member.active);
  const records = adults.map((adult) => readSegments(household, adult.id, date));
  const complete =
    adults.length > 0 &&
    new Set(adults.map((adult) => adult.id)).size === adults.length &&
    records.every((record) => record.complete);
  const points = [
    ...new Set([
      0,
      24 * 60,
      ...records.flatMap((record) => record.segments.flatMap((s) => [s.start, s.end])),
    ]),
  ].sort((a, b) => a - b);
  const gaps: Interval[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i];
    const end = points[i + 1];
    if (start === undefined || end === undefined || start >= end) continue;
    const states = records.map((record) => {
      if (!record.hasDay) return 'unknown';
      return record.segments.some(
        (segment) => segment.away && segment.start <= start && segment.end >= end,
      )
        ? 'cannot'
        : 'assumedCan';
    });
    if (!states.includes('assumedCan') && states.includes('cannot')) add(gaps, start, end);
  }
  return { gaps, complete };
}

/** 分かれた空きと、その一段だけを対象にする依頼窓を独立に照らす。 */
export function checkModeledCareSplit(
  model: ModeledCareGaps,
  claim: CareSplitClaim,
): CareSplitCheck {
  if (!model.complete) return { violations: [], undetermined: true };
  const violations: CareSplitCheck['violations'] = [];
  const split = model.gaps.length >= 2;
  if (split && claim.reported === undefined) violations.push('missing');
  if (
    claim.reported !== undefined &&
    (!split ||
      claim.reported.length !== model.gaps.length ||
      claim.reported.some((gap, index) => {
        const expected = model.gaps[index];
        return !expected || gap.start !== expected.start || gap.end !== expected.end;
      }))
  )
    violations.push('mismatch');
  if (split) {
    const [longest] = [...model.gaps].sort(
      (a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start,
    );
    if (longest && (claim.window.start !== longest.start || claim.window.end !== longest.end))
      violations.push('window');
    if (claim.recommended) violations.push('recommended');
  }
  return { violations, undetermined: false };
}
