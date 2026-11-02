import type { PlanResult, Task } from '@maniau/core';

/** 比較中の候補と、家族が実際に選んだ本命・予備を区別する。 */
export function executionScope(
  task: Task,
  plan: PlanResult,
): 'active' | 'candidate' | 'inactive' | 'unknown' {
  if (task.commitment === 'done') return 'active';
  if (!task.live || ['declined', 'withdrawn', 'cancelled'].includes(task.commitment))
    return 'inactive';
  if (task.cancels || !task.basis.optionKey) return 'active';
  if (
    task.commitment === 'accepted' ||
    plan.requests.some(
      (request) =>
        request.taskKey === task.key &&
        (request.state === 'awaitingReply' || request.state === 'confirmed'),
    )
  )
    return 'active';
  const arrangement = plan.arrangements.find((entry) => entry.key === task.basis.arrangementKey);
  if (!arrangement) return 'unknown';
  if (
    arrangement.chosenOptionKey === task.basis.optionKey ||
    arrangement.backupOptionKeys.includes(task.basis.optionKey)
  )
    return 'active';
  return 'candidate';
}

export function isRecommended(task: Task, plan: PlanResult): boolean {
  if (!task.basis.optionKey || !task.basis.arrangementKey) return false;
  const arrangement = plan.arrangements.find((entry) => entry.key === task.basis.arrangementKey);
  return arrangement?.recommendedOptionKey === task.basis.optionKey;
}
