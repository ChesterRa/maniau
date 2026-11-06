import type { Arrangement, Household, PlanResult, Task } from '@maniau/core';
import type { History } from './history';
import { optionFailure } from './plan';
import { matchesArrangementDay, matchesArrangementWindow } from './time';

/**
 * 本命が外の相手の返事で決まったか。依頼の返事は計画の state を信じず事象から読み、送信時の根拠
 * （古い事象なら本命の手順）で案をたどる。手配が生き、本命として選ばれている間、その本命の依頼は
 * 生きている。事象や依頼の所属が足りなければ、決まったとは言えない。
 */
function primaryConfirmed(
  arrangement: Arrangement,
  primary: string,
  plan: PlanResult,
  history: History,
  timeZone: string,
): boolean | undefined {
  if (!history.complete || !arrangement.live) return undefined;
  const option = arrangement.options.find((entry) => entry.key === primary);
  if (!option) return undefined;
  if (optionFailure(option, arrangement, plan, history, timeZone)) return false;

  const primaryRequests = [...history.requests.entries()].filter(([, sent]) => {
    if (sent.state === 'cancelled') return false;
    if (sent.snapshot) {
      const { basis } = sent.snapshot;
      return basis.arrangementKey === arrangement.key && basis.optionKey === primary;
    }
    const task = plan.tasks.find((entry) => entry.key === sent.taskKey);
    return (
      option.taskKeys.includes(sent.taskKey) ||
      (task?.basis.arrangementKey === arrangement.key && task.basis.optionKey === primary)
    );
  });
  // 前の日時への依頼は今の根拠にならない。時段の控えが無ければ、今の依頼か未判定。
  if (
    primaryRequests.some(
      ([, request]) =>
        ['confirmed', 'awaitingReply', 'turnedDown'].includes(request.state) &&
        matchesArrangementDay(
          request.snapshot?.window,
          arrangement,
          timeZone,
          history.needShapes.get(arrangement.key),
        ) === undefined,
    )
  )
    return undefined;
  const currentRequests = primaryRequests.filter(
    ([, request]) =>
      matchesArrangementDay(
        request.snapshot?.window,
        arrangement,
        timeZone,
        history.needShapes.get(arrangement.key),
      ) === true,
  );
  if (
    currentRequests.some(
      ([id, sent]) =>
        ((arrangement.kind === 'childCare' ||
          (arrangement.kind === 'need' && history.needShapes.get(arrangement.key) === 'window')) &&
          matchesArrangementWindow(sent.snapshot?.window, arrangement) === false) ||
        plan.requests.some((request) => request.requestId === id && request.needsCheck),
    )
  )
    return false;
  let confirmed = currentRequests.filter(([, request]) => request.state === 'confirmed');
  if (confirmed.length === 0) return false;
  if (arrangement.kind === 'need') {
    const possible = confirmed.some(([id]) => history.needRequestCurrent.get(id) === undefined);
    confirmed = confirmed.filter(([id]) => history.needRequestCurrent.get(id) === true);
    if (confirmed.length === 0) return possible ? undefined : false;
  }
  const waiting = currentRequests.filter(([, request]) => request.state === 'awaitingReply');
  if (
    waiting.some(([id]) =>
      plan.requests.some((request) => request.requestId === id && request.live),
    )
  )
    return false;
  // 返事待ちだが今は不要という計画だけでは、予備を不要と確定しない。
  if (waiting.length > 0) return undefined;
  // 控えも今の作業も無い送信は、どの案の返事待ちか分からない。無かった事にはしない。
  if (
    [...history.requests.values()].some(
      (sent) =>
        !sent.snapshot &&
        sent.state === 'awaitingReply' &&
        !plan.tasks.some((task) => task.key === sent.taskKey) &&
        !arrangement.options.some((entry) => entry.taskKeys.includes(sent.taskKey)),
    )
  )
    return undefined;
  // 現在の依頼が計画から欠けている・不要とされている時、根拠を確かめずに予備を外さない。
  if (
    !confirmed.some(([id]) =>
      plan.requests.some((request) => request.requestId === id && request.live),
    )
  )
    return undefined;
  return true;
}

/** 比較中の候補と、家族が実際に選んだ本命・予備を区別する。 */
export function executionScope(
  task: Task,
  plan: PlanResult,
  household: Household,
  history: History,
): 'active' | 'candidate' | 'inactive' | 'unknown' {
  if (task.commitment === 'done') return 'active';
  if (!task.live || ['declined', 'withdrawn', 'cancelled'].includes(task.commitment))
    return 'inactive';
  if (task.cancels || !task.basis.optionKey) return 'active';
  const arrangement = plan.arrangements.find((entry) => entry.key === task.basis.arrangementKey);
  if (!arrangement) return 'unknown';
  // 家族が使えないとした子の居場所の手の作業は、もう進めない（家庭の記録で見る。計画の印には頼らない）。
  const templateId = arrangement.options.find(
    (entry) => entry.key === task.basis.optionKey,
  )?.templateId;
  if (
    arrangement.kind === 'childCare' &&
    templateId !== undefined &&
    household.unusableCareOptionIds?.includes(templateId)
  )
    return 'inactive';
  const selection = history.selections.get(arrangement.key);
  const primary = history.complete ? selection?.primary : arrangement.chosenOptionKey;
  const backups = history.complete ? [...(selection?.backups ?? [])] : arrangement.backupOptionKeys;
  const selected = [primary, ...backups].filter((key): key is string => key !== undefined);
  if (history.complete && selection?.dropped.has(task.basis.optionKey)) return 'candidate';
  if (selected.length > 0) {
    if (!selected.includes(task.basis.optionKey)) return 'candidate';
    const template = household.careOptions.find((entry) => entry.id === task.step?.templateId);
    const isExtra = template?.extraSteps.some((step) => step.id === task.step?.stepId);
    if (isExtra) {
      let inUse: string | undefined;
      for (const key of selected) {
        const option = arrangement.options.find((entry) => entry.key === key);
        if (!option) continue;
        const failure = optionFailure(option, arrangement, plan, history, household.timeZone);
        if (failure?.code === 'missedDeadline') return 'unknown';
        if (!failure) {
          inUse = key;
          break;
        }
      }
      if (!inUse) return 'unknown';
      if (inUse !== task.basis.optionKey) return 'candidate';
    } else if (
      primary &&
      task.basis.optionKey !== primary &&
      backups.includes(task.basis.optionKey)
    ) {
      const confirmed = primaryConfirmed(arrangement, primary, plan, history, household.timeZone);
      if (confirmed === undefined) return 'unknown';
      if (confirmed) return 'inactive';
    }
    return 'active';
  }
  if (
    task.commitment === 'accepted' ||
    plan.requests.some(
      (request) =>
        request.taskKey === task.key &&
        (request.state === 'awaitingReply' || request.state === 'confirmed'),
    )
  )
    return 'active';
  return 'candidate';
}

export function isRecommended(task: Task, plan: PlanResult): boolean {
  if (!task.basis.optionKey || !task.basis.arrangementKey) return false;
  const arrangement = plan.arrangements.find((entry) => entry.key === task.basis.arrangementKey);
  return arrangement?.recommendedOptionKey === task.basis.optionKey;
}
