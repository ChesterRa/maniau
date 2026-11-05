// 確かめた根拠と、計画の「未確認」と依頼窓を照らす。事象・時区を読む口は別に持つ。
import type { CareKnowledge } from './care-knowledge';
import { coveredBy, type Interval } from './time';

export interface CareKnowledgeClaim {
  missingAdults?: readonly string[];
  unsure?: readonly Interval[];
  arrangements: readonly Interval[];
  /** 元の事項が確実に有効な時だけ、必要な手配が存在することも照らす。 */
  requiresArrangement: boolean;
}

export type CareKnowledgeIssue =
  | 'missingAdults'
  | 'unsure'
  | 'arrangementOutsideCertain'
  | 'arrangementWindowMismatch'
  | 'arrangementDuplicate'
  | 'arrangementMissing';

function normalize(ranges: readonly Interval[]): Interval[] | undefined {
  if (
    ranges.some(
      (range) =>
        !Number.isInteger(range.start) ||
        !Number.isInteger(range.end) ||
        range.start < 0 ||
        range.end > 24 * 60 ||
        range.start >= range.end,
    )
  )
    return undefined;
  const out: Interval[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = out.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else out.push({ start: range.start, end: range.end });
  }
  return out;
}

/** 不明を正しく出した場合は違反にしない。親の記録や事項を照らせない場合の未判定は呼出側が扱う。 */
export function checkCareKnowledgeClaim(
  evidence: CareKnowledge,
  claim: CareKnowledgeClaim,
): CareKnowledgeIssue[] {
  const issues: CareKnowledgeIssue[] = [];
  const names = claim.missingAdults ?? [];
  if (
    names.length !== evidence.missingAdults.length ||
    names.some((id, i) => id !== evidence.missingAdults[i])
  )
    issues.push('missingAdults');
  const actual = normalize(claim.unsure ?? []);
  const expected = normalize(evidence.missing);
  if (!actual || !expected || JSON.stringify(actual) !== JSON.stringify(expected))
    issues.push('unsure');
  if (
    claim.arrangements.some(
      (range) => !normalize([range]) || !coveredBy(range.start, range.end, evidence.certain),
    )
  )
    issues.push('arrangementOutsideCertain');
  if (claim.arrangements.length > 1) issues.push('arrangementDuplicate');
  const [longest] = [...evidence.certain].sort(
    (a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start,
  );
  if (
    longest &&
    claim.arrangements.some((range) => range.start !== longest.start || range.end !== longest.end)
  )
    issues.push('arrangementWindowMismatch');
  if (claim.requiresArrangement && evidence.certain.length > 0 && claim.arrangements.length === 0) {
    issues.push('arrangementMissing');
  }
  return issues;
}
