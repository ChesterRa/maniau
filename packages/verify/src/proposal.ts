// 家族が見た控えと現在の提案を独立に照らす。エンジンの比較関数は使わない。
import type { Household, PlanResult, ProposalSnapshot, Task } from '@maniau/core';
import { collectFacts, type FactState, historicalItem } from './facts';
import { type History, needContent } from './history';
import { Collector } from './report';
import { instantMinute } from './time';

export function proposalMatches(task: Task, shown: ProposalSnapshot): boolean | undefined {
  let sameTime: boolean;
  if (task.start === undefined || task.end === undefined) {
    // 日だけ・日も無しの作業は、時刻を決めずに引き受けられる。それ以外の未配置は照らせない。
    if (
      (task.timing !== 'day' && task.timing !== 'undated') ||
      task.start !== undefined ||
      task.end !== undefined
    )
      return undefined;
    sameTime = shown.start === undefined && shown.end === undefined;
  } else {
    sameTime =
      shown.start !== undefined &&
      shown.end !== undefined &&
      instantMinute(task.start) === instantMinute(shown.start) &&
      instantMinute(task.end) === instantMinute(shown.end);
  }
  const keys = Object.keys(task.titleParams);
  const sameParams =
    keys.length === Object.keys(shown.titleParams).length &&
    keys.every(
      (key) =>
        Object.hasOwn(shown.titleParams, key) && task.titleParams[key] === shown.titleParams[key],
    );
  const late = task.detour?.delayedArrival;
  // 本人が子を見る作業は、見る子と手配の時間も見せた物と同じであること（無い控えは、ある作業と違う）。
  const sameWatch =
    task.watch === undefined
      ? shown.watch === undefined
      : shown.watch !== undefined &&
        task.watch.childId === shown.watch.childId &&
        instantMinute(task.watch.start) === instantMinute(shown.watch.start) &&
        instantMinute(task.watch.end) === instantMinute(shown.watch.end);
  return (
    sameTime &&
    sameWatch &&
    (late === undefined
      ? shown.delayedArrival === undefined
      : shown.delayedArrival !== undefined &&
        instantMinute(late) === instantMinute(shown.delayedArrival)) &&
    task.titleKey === shown.titleKey &&
    sameParams &&
    task.atPlaceId === shown.atPlaceId &&
    task.travelBeforeMin === shown.travelBeforeMin &&
    task.travelAfterMin === shown.travelAfterMin &&
    task.external?.to === shown.external?.to &&
    task.external?.kind === shown.external?.kind &&
    task.condition === shown.condition &&
    task.about === shown.about
  );
}

export function checkProposals(
  plan: PlanResult,
  history: History,
  report: Collector,
  household: Household,
  facts: FactState,
): void {
  const beforeAcceptance = new Map<number, FactState>();
  for (const task of plan.tasks) {
    if (!task.live) continue;
    if (task.commitment !== 'accepted') {
      if (task.reconfirm === true)
        report.violation(
          'proposal_reconfirm_state_invalid',
          task.key,
          '引き受けていない作業に再確認の印が付いている。',
        );
      continue;
    }
    const accepted = history.approvals.get(task.key);
    if (!history.complete || !accepted || accepted.assigneeId !== task.assigneeId) {
      report.undetermined(
        'proposal_acceptance_unverified',
        task.key,
        '本人が引き受けた時の記録を確かめられない。',
      );
      if (
        history.complete &&
        history.commitments.get(task.key) === 'accepted' &&
        task.reconfirm !== true
      ) {
        report.violation(
          'proposal_reconfirm_missing',
          task.key,
          '今の担当が見た控えを確認できないが、再確認の印がない。',
        );
      }
      continue;
    }
    const arrangement = plan.arrangements.find((entry) => entry.key === task.basis.arrangementKey);
    let needChanged: boolean | undefined = false;
    if (arrangement?.kind === 'need') {
      let prior = beforeAcceptance.get(accepted.seq);
      if (!prior) {
        const scratch = new Collector();
        const collected = collectFacts(
          history.events.filter((event) => event.seq < accepted.seq),
          scratch,
        );
        if (!scratch.issues.some((issue) => issue.kind === 'violation')) {
          prior = collected;
          beforeAcceptance.set(accepted.seq, prior);
        }
      }
      const ids = accepted.basisItemIds ?? task.basis.itemIds;
      const oldItem = ids.length === 1 && ids[0] ? prior?.items.get(ids[0]) : undefined;
      const currentId =
        ids.length === 1 && ids[0] ? historicalItem(facts, ids[0]).itemId : undefined;
      const currentItem = currentId ? facts.items.get(currentId) : undefined;
      const priorHousehold = history.events.findLast(
        (event) => event.type === 'householdSet' && event.seq < accepted.seq,
      );
      const wayId = task.step?.templateId;
      const oldWay =
        priorHousehold?.type === 'householdSet'
          ? priorHousehold.household.ways.find((entry) => entry.id === wayId)
          : undefined;
      const currentWay = household.ways.find((entry) => entry.id === wayId);
      if (
        !prior ||
        oldItem?.kind !== 'need' ||
        currentItem?.kind !== 'need' ||
        !ids[0] ||
        prior.staleItems.has(ids[0]) ||
        !currentId ||
        facts.staleItems.has(currentId) ||
        !oldWay ||
        !currentWay
      ) {
        needChanged = undefined;
        report.undetermined(
          'need_acceptance_basis_unverified',
          task.key,
          '引き受けた時のすることとやり方を確かめられない。',
        );
      } else {
        needChanged =
          JSON.stringify(needContent(oldItem, household.timeZone)) !==
            JSON.stringify(needContent(currentItem, household.timeZone)) ||
          JSON.stringify(oldWay) !== JSON.stringify(currentWay);
        if (needChanged && task.reconfirm !== true)
          report.violation(
            'need_acceptance_stale',
            task.key,
            '引き受けた後にすることかやり方が変わり、見せ直しが要る。',
          );
      }
    }
    const matches = accepted.shown ? proposalMatches(task, accepted.shown) : false;
    if (matches === undefined) {
      report.undetermined('proposal_current_unplaced', task.key, '現在の提案の時刻を照らせない。');
      if (task.reconfirm !== true)
        report.violation(
          'proposal_reconfirm_missing',
          task.key,
          '現在の提案を置けていないが、再確認の印がない。',
        );
    } else if (!matches && task.reconfirm !== true) {
      report.violation(
        'proposal_reconfirm_missing',
        task.key,
        '見た控えが無いか現在の提案と違うが、再確認の印がない。',
      );
    } else if (matches && task.reconfirm === true && needChanged === false) {
      report.violation(
        'proposal_reconfirm_unnecessary',
        task.key,
        '見た控えと現在の提案が同じなのに、再確認の印が付いている。',
      );
    }
  }
}
