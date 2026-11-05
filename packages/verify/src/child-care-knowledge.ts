// その日の見守りの未確認と手配を、家庭・事項・事象から独立に照らす。
import { DateTime, type Household, type PlanResult, type Requirement } from '@maniau/core';
import { householdCareKnowledge } from './care-household-evidence';
import { checkCareKnowledgeClaim } from './care-knowledge-claim';
import { checkModeledCareSplit } from './child-care-gap-evidence';
import type { FactState } from './facts';
import type { History } from './history';
import type { Collector } from './report';
import { dateIndex, type Interval, instantMinute, localMinute } from './time';

/** 対象日の 00:00〜翌 00:00 を半開区間として読む。終点が翌日の 00:00 でもよい。 */
function localRange(start: string, end: string, date: string, tz: string): Interval | undefined {
  if (!DateTime.safeParse(start).success || !DateTime.safeParse(end).success) return undefined;
  const from = instantMinute(start);
  const to = instantMinute(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return undefined;
  try {
    const origin = dateIndex(date);
    const a = localMinute(from, tz).localIndex - origin;
    const b = localMinute(to, tz).localIndex - origin;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || a >= b || b > 24 * 60)
      return undefined;
    return { start: a, end: b };
  } catch {
    return undefined;
  }
}

function ranges(
  rows: readonly { start: string; end: string }[],
  date: string,
  tz: string,
): Interval[] | undefined {
  const out: Interval[] = [];
  for (const row of rows) {
    const range = localRange(row.start, row.end, date, tz);
    if (!range) return undefined;
    out.push(range);
  }
  return out;
}

function refs(rows: readonly string[], date: string, tz: string): Interval[] | undefined {
  const out: Interval[] = [];
  for (const row of rows) {
    const pair = row.split('/');
    if (pair.length !== 2 || pair[0] === undefined || pair[1] === undefined) return undefined;
    const range = localRange(pair[0], pair[1], date, tz);
    if (!range) return undefined;
    out.push(range);
  }
  return out;
}

function itemOf(requirement: Requirement, facts: FactState, history: History) {
  if (!history.complete || requirement.basis.itemIds.length !== 1) return undefined;
  const id = requirement.basis.itemIds[0];
  if (!id || facts.staleItems.has(id)) return undefined;
  const item = facts.items.get(id);
  const active = facts.active.get(id);
  return item?.kind === 'dayChange' &&
    item.interpretation.dayType === 'noSchool' &&
    item.interpretation.date === requirement.date &&
    (active === true || (active === 'unknown' && requirement.conditional === true))
    ? { item, active }
    : undefined;
}

/**
 * S3 の形式を持つ子の見守りの要件を照らす。返すキーは分割の既存検査に渡し、二重に違反を付けない。
 * 基になる事項や家庭の記録を一意に読めない時は、違反ではなく未判定とする。
 */
export function checkChildCareKnowledge(
  household: Household,
  plan: PlanResult,
  facts: FactState,
  history: History,
  report: Collector,
): Set<string> {
  const checked = new Set<string>();
  const tz = household.timeZone;
  for (const requirement of plan.requirements) {
    if (!requirement.live || requirement.kind !== 'childCare') continue;
    checked.add(requirement.key);
    const date = requirement.date;
    const source = itemOf(requirement, facts, history);
    if (!date || !source) {
      report.undetermined(
        'child_care_knowledge_unverified',
        requirement.key,
        '元の事項と対象日を照らせない。',
      );
      continue;
    }
    const evidence = householdCareKnowledge(household, date);
    if (!evidence) {
      report.undetermined(
        'child_care_knowledge_unverified',
        requirement.key,
        '家の記録から時間を照らせない。',
      );
      continue;
    }
    const unsure = ranges(requirement.unsure ?? [], date, tz);
    if (!unsure) {
      report.violation(
        'child_care_unsure_invalid',
        requirement.key,
        '未確認の時間が対象日の範囲でない。',
      );
      continue;
    }
    const arrangements = plan.arrangements.filter(
      (a) => a.live && a.kind === 'childCare' && a.requirementKey === requirement.key,
    );
    const activeChildren = household.members.filter(
      (member) => member.kind === 'child' && member.active,
    );
    if (activeChildren.length === 1) {
      const child = activeChildren[0];
      for (const arrangement of arrangements) {
        if (arrangement.childId === undefined) {
          report.undetermined(
            'child_care_child_unverified',
            arrangement.key,
            '手配の対象の子を照らせない。',
          );
        } else if (arrangement.childId !== child?.id) {
          report.violation(
            'child_care_child_mismatch',
            arrangement.key,
            '手配の対象が家の子と違う。',
          );
        }
      }
    }
    const windows = arrangements.map((arrangement) =>
      localRange(arrangement.start, arrangement.end, date, tz),
    );
    if (windows.some((window) => window === undefined)) {
      report.violation(
        'child_care_knowledge_window',
        requirement.key,
        '手配の窓が対象日の範囲でない。',
      );
    }
    const claims = checkCareKnowledgeClaim(evidence, {
      ...(requirement.missingAdults === undefined
        ? {}
        : { missingAdults: requirement.missingAdults }),
      unsure,
      arrangements: windows.filter((window): window is Interval => window !== undefined),
      requiresArrangement: source.active === true && requirement.conditional !== true,
    });
    for (const issue of claims) {
      const code =
        issue === 'missingAdults'
          ? 'child_care_missing_adults'
          : issue === 'unsure'
            ? 'child_care_unsure_mismatch'
            : issue === 'arrangementMissing'
              ? 'child_care_arrangement_missing'
              : issue === 'arrangementDuplicate'
                ? 'child_care_arrangement_duplicate'
                : 'child_care_knowledge_window';
      report.violation(code, requirement.key, '見守りの未確認か手配が家の記録と違う。');
    }
    if (source.active === 'unknown' && evidence.certain.length > 0 && arrangements.length === 0) {
      report.undetermined(
        'child_care_knowledge_unverified',
        requirement.key,
        '条件付きの手配の有無を確定できない。',
      );
    }
    for (const [index, arrangement] of arrangements.entries()) {
      const window = windows[index];
      if (!window) continue;
      const splits = arrangement.reasons.filter((reason) => String(reason.code) === 'splitGaps');
      if (splits.length > 1)
        report.violation(
          'child_care_split_duplicate',
          arrangement.key,
          '分かれた空きの印が重複している。',
        );
      const stated = splits[0] ? refs(splits[0].refs, date, tz) : undefined;
      if (splits[0] && !stated)
        report.violation(
          'child_care_split_invalid',
          arrangement.key,
          '空きの時刻を対象日として読めない。',
        );
      const split = checkModeledCareSplit(
        { gaps: evidence.certain, complete: true },
        {
          ...(splits.length ? { reported: stated ?? [] } : {}),
          window,
          recommended:
            arrangement.recommendedOptionKey !== undefined ||
            arrangement.recommendedReason !== undefined,
        },
      );
      for (const issue of split.violations) {
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
  }
  // 学校・園の休みが確かに有効で、対象の子が一人の時に限り、要件そのものが落ちていないかを照らす。
  // 置換の先・条件・複数の子を判断できない場合は、空きを確定しない。
  const children = household.members.filter((member) => member.kind === 'child' && member.active);
  let today: string | undefined;
  try {
    today = localMinute(instantMinute(plan.now), tz).date;
  } catch {
    today = undefined;
  }
  if (children.length === 1 && today) {
    for (const [id, item] of facts.items) {
      if (item.kind !== 'dayChange' || item.interpretation.dayType !== 'noSchool') continue;
      const date = item.interpretation.date;
      if (!date || date < today || facts.staleItems.has(id)) continue;
      if (!['school', 'nursery'].includes(facts.sourceSenders.get(item.sourceId) ?? '')) continue;
      const active = facts.active.get(id);
      if (active === false || active === undefined) continue;
      const present = plan.requirements.some(
        (requirement) =>
          requirement.live &&
          requirement.kind === 'childCare' &&
          requirement.date === date &&
          requirement.basis.itemIds.includes(id),
      );
      if (present) continue;
      if (history.complete && active === true) {
        report.violation(
          'child_care_requirement_missing',
          id,
          '学校・園の休みから必要な子の要件がない。',
        );
      } else {
        report.undetermined(
          'child_care_knowledge_unverified',
          id,
          '条件付きの休みと要件を照らせない。',
        );
      }
    }
  }
  return checked;
}
