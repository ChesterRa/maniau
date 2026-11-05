// 子の居場所の分かれた空きを、家庭の記録から独立に照らす。
import { DateTime, type Household, type PlanResult, type Requirement } from '@maniau/core';
import { checkModeledCareSplit, modeledCareGaps } from './child-care-gap-evidence';
import type { FactState } from './facts';
import type { History } from './history';
import type { Collector } from './report';
import { dateIndex, type Interval, instantMinute, localMinute } from './time';

/** 一日の局所時刻を相互比較する。違う表記でも同じ瞬間なら同じ時刻になる。 */
function localRange(start: string, end: string, date: string, tz: string): Interval | undefined {
  if (!DateTime.safeParse(start).success || !DateTime.safeParse(end).success) return undefined;
  const from = instantMinute(start);
  const to = instantMinute(end);
  if (from >= to) return undefined;
  const a = localMinute(from, tz);
  const b = localMinute(to, tz);
  if (a.date !== date || b.date !== date) return undefined;
  const origin = dateIndex(date);
  return { start: a.localIndex - origin, end: b.localIndex - origin };
}

function readRefs(refs: readonly string[], date: string, tz: string): Interval[] | undefined {
  const ranges: Interval[] = [];
  for (const ref of refs) {
    const parts = ref.split('/');
    if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) return undefined;
    const range = localRange(parts[0], parts[1], date, tz);
    if (!range) return undefined;
    ranges.push(range);
  }
  return ranges;
}

/** 同じ要件の手配・根拠のある複数の空き・勧め・既存の単一の依頼窓を照らす。 */
export function checkSplitCareClaims(
  household: Household,
  plan: PlanResult,
  facts: FactState,
  history: History,
  report: Collector,
): void {
  const validBasis = (requirement: Requirement): boolean => {
    if (!history.complete || requirement.basis.itemIds.length !== 1) return false;
    const id = requirement.basis.itemIds[0];
    if (!id || facts.staleItems.has(id)) return false;
    const item = facts.items.get(id);
    const active = facts.active.get(id);
    return (
      item?.kind === 'dayChange' &&
      item.interpretation.dayType === 'noSchool' &&
      item.interpretation.date === requirement.date &&
      (active === true || (active === 'unknown' && requirement.conditional === true))
    );
  };
  for (const arrangement of plan.arrangements) {
    if (!arrangement.live) continue;
    const splits = arrangement.reasons.filter((reason) => String(reason.code) === 'splitGaps');
    if (arrangement.kind !== 'childCare') {
      if (splits.length)
        report.violation(
          'child_care_split_kind',
          arrangement.key,
          '子の居場所ではない手配に分かれた空きがある。',
        );
      continue;
    }
    const requirement = plan.requirements.find((entry) => entry.key === arrangement.requirementKey);
    if (!requirement?.live || requirement.kind !== 'childCare' || !requirement.date) {
      if (splits.length)
        report.undetermined(
          'child_care_split_unverified',
          arrangement.key,
          '空きを照らす要件の日を確かめられない。',
        );
      continue;
    }
    const model = modeledCareGaps(household, requirement.date);
    if (!validBasis(requirement)) {
      if (splits.length || model.gaps.length >= 2)
        report.undetermined(
          'child_care_split_unverified',
          arrangement.key,
          '元の事項と要件の日を照らせない。',
        );
      continue;
    }
    if (!model.complete) {
      if (splits.length || model.gaps.length >= 2)
        report.undetermined(
          'child_care_split_unverified',
          arrangement.key,
          '家の時間の記録から空きを照らせない。',
        );
      continue;
    }
    if (splits.length > 1)
      report.violation(
        'child_care_split_duplicate',
        arrangement.key,
        '分かれた空きの印が重複している。',
      );
    const refs = splits[0]
      ? readRefs(splits[0].refs, requirement.date, household.timeZone)
      : undefined;
    if (splits[0] && refs === undefined)
      report.violation(
        'child_care_split_invalid',
        arrangement.key,
        '空きの時刻をその日の範囲として読めない。',
      );
    const window = localRange(
      arrangement.start,
      arrangement.end,
      requirement.date,
      household.timeZone,
    );
    if (!window) {
      if (splits.length || model.gaps.length >= 2)
        report.violation(
          'child_care_split_window_mismatch',
          arrangement.key,
          '依頼の窓が要件の日と一致しない。',
        );
      continue;
    }
    const check = checkModeledCareSplit(model, {
      ...(splits.length ? { reported: refs ?? [] } : {}),
      window,
      recommended:
        arrangement.recommendedOptionKey !== undefined ||
        arrangement.recommendedReason !== undefined,
    });
    for (const issue of check.violations) {
      const code =
        issue === 'missing'
          ? 'child_care_split_missing'
          : issue === 'mismatch'
            ? 'child_care_split_mismatch'
            : issue === 'window'
              ? 'child_care_split_window_mismatch'
              : 'child_care_split_recommended';
      report.violation(code, arrangement.key, '分かれた空きの表現が家の記録と違う。');
    }
  }

  for (const requirement of plan.requirements) {
    if (
      !requirement.live ||
      requirement.kind !== 'childCare' ||
      requirement.nature !== 'required' ||
      !requirement.date
    )
      continue;
    if (
      plan.arrangements.some(
        (entry) =>
          entry.live && entry.kind === 'childCare' && entry.requirementKey === requirement.key,
      )
    )
      continue;
    const model = modeledCareGaps(household, requirement.date);
    if (!model.complete || model.gaps.length < 2) continue;
    if (!validBasis(requirement) || requirement.conditional)
      report.undetermined(
        'child_care_split_unverified',
        requirement.key,
        '条件付きの子の居場所と空きの対応を確かめられない。',
      );
    else
      report.violation(
        'child_care_split_missing',
        requirement.key,
        '分かれた空きがある子の居場所の手配が無い。',
      );
  }
}
