import type { Household, PlanResult, Task } from '@maniau/core';
import type { History } from './history';
import { optionFailure } from './plan';

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
        const failure = optionFailure(option, arrangement, plan, history);
        if (failure?.code === 'missedDeadline') return 'unknown';
        if (!failure) {
          inUse = key;
          break;
        }
      }
      if (!inUse) return 'unknown';
      if (inUse !== task.basis.optionKey) return 'candidate';
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
