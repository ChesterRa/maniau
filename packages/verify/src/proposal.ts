// 家族が見た控えと現在の提案を独立に照らす。エンジンの比較関数は使わない。
import type { PlanResult, ProposalSnapshot, Task } from '@maniau/core';
import type { History } from './history';
import type { Collector } from './report';
import { instantMinute } from './time';

export function proposalMatches(task: Task, shown: ProposalSnapshot): boolean | undefined {
  if (!task.start || !task.end) return undefined;
  const keys = Object.keys(task.titleParams);
  const sameParams =
    keys.length === Object.keys(shown.titleParams).length &&
    keys.every(
      (key) =>
        Object.hasOwn(shown.titleParams, key) && task.titleParams[key] === shown.titleParams[key],
    );
  const late = task.detour?.delayedArrival;
  return (
    instantMinute(task.start) === instantMinute(shown.start) &&
    instantMinute(task.end) === instantMinute(shown.end) &&
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
    task.condition === shown.condition
  );
}

export function checkProposals(plan: PlanResult, history: History, report: Collector): void {
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
    } else if (matches && task.reconfirm === true) {
      report.violation(
        'proposal_reconfirm_unnecessary',
        task.key,
        '見た控えと現在の提案が同じなのに、再確認の印が付いている。',
      );
    }
  }
}
