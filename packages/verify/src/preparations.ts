// 一度だけの前提と資源の扱いを、家庭の情報と事項の事象から照らす。
import type { Household, Item, OptionPlan, PlanResult, Preparation } from '@maniau/core';
import type { FactState } from './facts';
import type { History } from './history';
import type { Collector } from './report';
import { dateFromIndex, dateIndex, instantMinute, localMinute } from './time';

type Gap = NonNullable<OptionPlan['needsPreparation']>[number];

/** 使う日は元の事項から得る。計画中の日時を、検証する日時の根拠にはしない。 */
function useDate(item: Item, timeZone: string): string | undefined {
  const value = item.interpretation;
  if (value.shape === 'window') return value.date;
  if (value.shape === 'by' && value.deadline)
    return localMinute(instantMinute(value.deadline), timeZone).date;
  return undefined;
}

/** 前提の種類を見ず、対象・状態・使う日の順に確認する。 */
function expectedGap(
  preparation: Preparation,
  date: string,
  memberId: string | undefined,
): Gap | undefined {
  const scope = preparation.appliesTo;
  let state: Gap['state'] | undefined;
  if (scope.kind === 'unknown') state = 'appliesUnknown';
  else if (scope.kind === 'members' && memberId === undefined) state = 'personUnknown';
  else if (scope.kind === 'members' && memberId && !scope.memberIds.includes(memberId))
    state = 'otherPerson';
  else if (preparation.state !== 'done') state = preparation.state;
  else if (preparation.validUntil && preparation.validUntil < date) state = 'expired';
  if (!state) return undefined;

  // 確認された「暦日」だけで、時刻を作らず日付を求める。
  const by = preparation.lead
    ? dateFromIndex(dateIndex(date) - preparation.lead.days * 24 * 60)
    : undefined;
  return { preparationId: preparation.id, state, ...(by === undefined ? {} : { by }) };
}

export function checkPreparations(
  household: Household,
  plan: PlanResult,
  facts: FactState,
  history: History,
  report: Collector,
): void {
  for (const arrangement of plan.arrangements) {
    if (arrangement.kind !== 'need' || !arrangement.live) continue;
    const relevant = arrangement.options.filter((option) => {
      const way = household.ways.find((entry) => entry.id === option.templateId);
      return (
        (way?.requires?.length ?? 0) > 0 ||
        (option.needsPreparation?.length ?? 0) > 0 ||
        (way?.resourceIds?.length ?? 0) > 0 ||
        (option.unusedResources?.length ?? 0) > 0
      );
    });
    if (relevant.length === 0) continue;

    const requirement = plan.requirements.find((entry) => entry.key === arrangement.requirementKey);
    const id = requirement?.basis.itemIds.length === 1 ? requirement.basis.itemIds[0] : undefined;
    const item = id ? facts.items.get(id) : undefined;
    const date = item?.kind === 'need' ? useDate(item, household.timeZone) : undefined;
    const trustworthy =
      history.complete &&
      id !== undefined &&
      item?.kind === 'need' &&
      !facts.staleItems.has(id) &&
      facts.active.get(id) === true &&
      date !== undefined;
    let anotherOpenGap = false;

    for (const option of relevant) {
      const way = household.ways.find((entry) => entry.id === option.templateId);
      if (!way) {
        report.undetermined(
          'preparation_unverified',
          option.key,
          'やり方の前提や資源を確かめられない。',
        );
        continue;
      }
      const resources = (way.resourceIds ?? []).map((resourceId) => ({
        id: resourceId,
        matches: household.resources.filter((resource) => resource.id === resourceId),
      }));
      const resourceKnown = resources.every(({ matches }) => matches.length === 1);
      const expectedUnused = resources
        .filter(({ matches }) => matches.length === 1 && matches[0]?.use === 'notUsed')
        .map(({ id: resourceId }) => resourceId);
      const actualUnused = option.unusedResources ?? [];
      if (!resourceKnown) {
        report.undetermined(
          'resource_use_unverified',
          option.key,
          '使う資源と家族の扱いを確かめられない。',
        );
      } else if (
        actualUnused.length !== expectedUnused.length ||
        new Set(actualUnused).size !== actualUnused.length ||
        expectedUnused.some((resourceId) => !actualUnused.includes(resourceId))
      ) {
        report.violation(
          'resource_use_mismatch',
          option.key,
          '使わない資源の印が家族の扱いと合わない。',
        );
      }
      if (
        arrangement.recommendedOptionKey === option.key &&
        (expectedUnused.length > 0 || actualUnused.length > 0)
      ) {
        report.violation(
          'resource_not_used_recommended',
          option.key,
          '家族が使わないとした資源を使う案を勧めている。',
        );
      }
      const actual = option.needsPreparation ?? [];
      const actualIds = actual.map((gap) => gap.preparationId);
      if (new Set(actualIds).size !== actualIds.length) {
        report.violation('preparation_duplicate', option.key, '同じ前提の印が重複している。');
      }
      if (actualIds.some((key) => !(way.requires ?? []).includes(key))) {
        report.violation('preparation_unexpected', option.key, 'やり方に無い前提の印がある。');
      }
      if (arrangement.recommendedOptionKey === option.key && actual.length > 0) {
        report.violation(
          'preparation_recommended',
          option.key,
          '満たされていない前提のある案を勧めている。',
        );
      }
      if ((way.requires?.length ?? 0) === 0 && actual.length === 0) continue;
      if (!trustworthy || !item || !date) {
        report.undetermined(
          'preparation_unverified',
          option.key,
          '使う日と対象を事項の事象から確かめられない。',
        );
        continue;
      }
      for (const preparationId of way.requires ?? []) {
        const matches = household.preparations.filter((entry) => entry.id === preparationId);
        if (matches.length !== 1 || !matches[0]) {
          report.undetermined('preparation_unverified', option.key, '必要な前提を確かめられない。');
          continue;
        }
        const expected = expectedGap(matches[0], date, item.interpretation.forMemberId);
        if (
          expected &&
          resourceKnown &&
          expectedUnused.length === 0 &&
          !option.expired &&
          option.decisionDeadline !== undefined
        ) {
          anotherOpenGap = true;
        }
        const listed = actual.filter((gap) => gap.preparationId === preparationId);
        if (
          (expected === undefined && listed.length > 0) ||
          (expected !== undefined &&
            (listed.length !== 1 ||
              listed[0]?.state !== expected.state ||
              listed[0]?.by !== expected.by))
        ) {
          report.violation(
            'preparation_mismatch',
            option.key,
            '前提の印・状態・日付が家庭の情報と使う日に合わない。',
            preparationId,
          );
        }
        if (expected && arrangement.recommendedOptionKey === option.key && actual.length === 0) {
          report.violation(
            'preparation_recommended',
            option.key,
            '満たされていない前提のある案を勧めている。',
          );
        }
      }
    }
    // まだ何も選んでいない時は、断られた選択肢を除く処理もない。比較対象に前提の
    // 未確認が残るなら、別の案も「比べて勧めた」とは言えない。
    if (
      anotherOpenGap &&
      arrangement.recommendedOptionKey &&
      !arrangement.chosenOptionKey &&
      arrangement.backupOptionKeys.length === 0
    ) {
      report.violation(
        'preparation_comparison_unverified',
        arrangement.key,
        '比べる案に満たされていない前提があるのに推薦している。',
      );
    }
  }
}
