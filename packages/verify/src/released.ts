// 消えた作業の札を、現在の作業ではなく、本人の引き受けの事象と照らす。
import { type Household, type Item, type PlanResult, toEpochMinutes } from '@maniau/core';
import { collectFacts, type FactState } from './facts';
import type { History } from './history';
import { Collector } from './report';
import { executionScope } from './scope';

const sameTime = (a: string | undefined, b: string | undefined): boolean =>
  a === undefined || b === undefined ? a === b : toEpochMinutes(a) === toEpochMinutes(b);

const sameParams = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

// 再読の ID は同じ事項の証明にならない。条件を含む元の読み取りと今の読み取りを照らす。
function condition(item: Item, facts: FactState): unknown {
  const path = new Set<string>();
  const visit = (id: string): unknown => {
    if (path.has(id)) return undefined;
    const node = facts.conditions.get(id);
    if (!node) return undefined;
    path.add(id);
    let value: unknown;
    if (node.kind === 'eq') {
      const unknown = facts.unknowns.get(node.unknownId);
      value = unknown ? { ...node, unknown } : undefined;
    } else if (node.kind === 'not') {
      const child = visit(node.childId);
      value = child === undefined ? undefined : { kind: node.kind, child };
    } else {
      const children = node.childIds.map(visit);
      value = children.includes(undefined) ? undefined : { kind: node.kind, children };
    }
    path.delete(id);
    return value;
  };
  return item.conditionNodeId ? visit(item.conditionNodeId) : null;
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)));
  });
}

function sameItem(
  before: Item | undefined,
  after: Item | undefined,
  old: FactState,
  now: FactState,
) {
  if (!before || !after) return 'unknown';
  const identity = (item: Item) => ({
    sourceId: item.sourceId,
    kind: item.kind,
    written: item.written,
    sentenceIds: item.sentenceIds,
    interpretation: item.interpretation,
  });
  if (stable(identity(before)) !== stable(identity(after))) return 'different';
  const oldCondition = condition(before, old);
  const newCondition = condition(after, now);
  if (oldCondition === undefined || newCondition === undefined) return 'unknown';
  return stable(oldCondition) === stable(newCondition) ? 'same' : 'different';
}

export function checkReleased(
  household: Household,
  plan: PlanResult,
  facts: FactState,
  history: History,
  report: Collector,
): void {
  const releases = plan.released ?? [];
  const seen = new Set<string>();
  const purgedSources = new Set(
    history.events.flatMap((event) =>
      event.type === 'sourceContentPurged' && event.scope === 'all' ? [event.sourceId] : [],
    ),
  );
  const earlierFacts = new Map<number, FactState>();
  for (const entry of releases) {
    if (seen.has(entry.taskKey))
      report.violation('released_duplicate', entry.taskKey, '同じ引き受けが複数ある。');
    seen.add(entry.taskKey);
    const task = plan.tasks.find((candidate) => candidate.key === entry.taskKey);
    const scope =
      task?.live && history.complete ? executionScope(task, plan, household, history) : undefined;
    if (task?.live && scope === 'active') {
      report.violation(
        'released_task_still_live',
        entry.taskKey,
        'まだ進めている作業を不要としている。',
      );
    } else if (task?.live && (scope === undefined || scope === 'unknown')) {
      report.undetermined(
        'released_scope_unverified',
        entry.taskKey,
        'その作業をまだ進めているか確かめられない。',
      );
    }
    const member = household.members.find((candidate) => candidate.id === entry.assigneeId);
    if (member?.kind !== 'adult' || !member.active)
      report.violation('released_assignee_inactive', entry.taskKey, '宛先が有効な大人ではない。');
    if (!history.complete) {
      report.undetermined(
        'released_acceptance_unverified',
        entry.taskKey,
        '引き受けを確かめられない。',
      );
      continue;
    }
    const approval = history.approvals.get(entry.taskKey);
    // 送った後、依頼が取り消されたために現在の作業を開き直す場合、検査用の commitment は
    // accepted になるが、元の事実は送信による done。古い承諾を「不要」にしない。
    const accepted =
      history.commitments.get(entry.taskKey) === 'accepted' &&
      !history.requestBasedDone.has(entry.taskKey);
    if (!approval || !accepted) {
      report.violation(
        'released_without_acceptance',
        entry.taskKey,
        '本人の有効な引き受けがない。',
      );
      continue;
    }
    if (entry.assigneeId !== approval.assigneeId)
      report.violation('released_assignee_mismatch', entry.taskKey, '引き受けた本人と宛先が違う。');
    const basisUnknown =
      approval.basisSourceIds === undefined || approval.basisItemIds === undefined;
    const sourceUnknownAfterPurge = basisUnknown && purgedSources.size > 0;
    const sourcePurged = approval.basisSourceIds?.some((id) => purgedSources.has(id)) ?? false;
    if (sourcePurged || sourceUnknownAfterPurge) {
      if (entry.reason !== 'unconfirmed')
        report.violation(
          'released_purged_reason',
          entry.taskKey,
          '根拠を消した引き受けを不要と決めている。',
        );
      if (entry.content || entry.start || entry.end)
        report.violation(
          'released_purged_content',
          entry.taskKey,
          '消した出典に頼る可能性のある控えを出している。',
        );
      continue;
    }
    const sourceUnconfirmed = sourcePurged || sourceUnknownAfterPurge || basisUnknown;
    const withdrawn =
      approval.basisSourceIds?.some((id) =>
        history.events.some((event) => event.type === 'sourceWithdrawn' && event.sourceId === id),
      ) ?? false;
    const basisItems = approval.basisItemIds ?? [];
    const dismissed = (id: string) => {
      const verdict = history.events.findLast(
        (event) =>
          (event.type === 'itemDismissed' ||
            event.type === 'itemConfirmed' ||
            event.type === 'itemCorrected') &&
          event.itemId === id,
      );
      return verdict?.type === 'itemDismissed';
    };
    const acceptedAt = history.commitmentSeq.get(entry.taskKey);
    // facts が独立に採用した読み取りだけを数える。古い版や型の違う読み取りは数えない。
    const reread =
      acceptedAt !== undefined &&
      (approval.basisSourceIds?.some((id) => (facts.sourceReadingSeq.get(id) ?? 0) > acceptedAt) ??
        false);
    const dismissedIds = basisItems.filter(dismissed);
    let prior = acceptedAt === undefined ? undefined : earlierFacts.get(acceptedAt);
    if (dismissedIds.length > 0 && acceptedAt !== undefined && !prior) {
      prior = collectFacts(
        history.events.filter((event) => event.seq <= acceptedAt),
        new Collector(),
      );
      earlierFacts.set(acceptedAt, prior);
    }
    const dismissalIdentity = dismissedIds.map((id) =>
      prior ? sameItem(prior.items.get(id), facts.items.get(id), prior, facts) : 'unknown',
    );
    const changedDismissal = dismissalIdentity.includes('different');
    const uncertainDismissal = dismissalIdentity.includes('unknown');
    const allDismissed =
      basisItems.length > 0 &&
      dismissalIdentity.length === basisItems.length &&
      dismissalIdentity.every((identity) => identity === 'same');
    const possibleEffect = basisItems.some(
      (id) =>
        !dismissed(id) &&
        [...facts.items.values()].some(
          (item) =>
            facts.active.get(item.id) !== false &&
            item.effects.some(
              (effect) =>
                (effect.type === 'cancel' || effect.type === 'replace') && effect.itemId === id,
            ),
        ),
    );
    if (reread && ((!task && !withdrawn) || task?.live === false)) {
      if (entry.reason !== 'unconfirmed')
        report.violation(
          'released_reason_mismatch',
          entry.taskKey,
          '読み直し後の要否を確かめていない。',
        );
    } else if (
      !task &&
      !withdrawn &&
      !allDismissed &&
      !changedDismissal &&
      (possibleEffect || uncertainDismissal)
    ) {
      report.undetermined(
        'released_fate_unverified',
        entry.taskKey,
        '見つからない事項への作用を確かめきれない。',
      );
    } else if (!(task?.live && (scope === undefined || scope === 'unknown'))) {
      const expected = task
        ? task.live
          ? 'inactive'
          : 'notLive'
        : !sourceUnconfirmed && (withdrawn || allDismissed)
          ? 'gone'
          : 'unconfirmed';
      if (entry.reason !== expected)
        report.violation('released_reason_mismatch', entry.taskKey, '作業の消え方と理由が違う。');
    }
    if (!approval.shown) {
      if (entry.content || entry.start || entry.end)
        report.violation(
          'released_content_without_snapshot',
          entry.taskKey,
          '控えのない引き受けに用件または時刻を補っている。',
        );
      report.undetermined(
        'released_snapshot_unverified',
        entry.taskKey,
        '引き受けた時の控えを確かめられない。',
      );
      continue;
    }
    const shown = approval.shown;
    if (
      entry.content?.titleKey !== shown.titleKey ||
      !sameParams(entry.content?.titleParams ?? {}, shown.titleParams) ||
      !sameTime(entry.start, shown.start) ||
      !sameTime(entry.end, shown.end)
    ) {
      report.violation(
        'released_snapshot_mismatch',
        entry.taskKey,
        '引き受けた時に見た用件・時刻と違う。',
      );
    }
    const until = shown.end ?? shown.start;
    if (until && toEpochMinutes(until) <= toEpochMinutes(plan.now))
      report.violation('released_expired', entry.taskKey, '時刻の過ぎた約束を残している。');
  }

  for (const [taskKey, approval] of history.approvals) {
    if (
      history.commitments.get(taskKey) !== 'accepted' ||
      history.requestBasedDone.has(taskKey) ||
      seen.has(taskKey)
    )
      continue;
    const task = plan.tasks.find((candidate) => candidate.key === taskKey);
    if (task?.live) {
      if (!history.complete) {
        report.undetermined(
          'released_scope_unverified',
          taskKey,
          'その作業をまだ進めているか確かめられない。',
        );
        continue;
      }
      const scope = executionScope(task, plan, household, history);
      if (scope === 'active') continue;
      if (scope === 'unknown') {
        report.undetermined(
          'released_scope_unverified',
          taskKey,
          'その作業をまだ進めているか確かめられない。',
        );
        continue;
      }
    }
    const member = household.members.find((candidate) => candidate.id === approval.assigneeId);
    if (member?.kind !== 'adult' || !member.active) continue;
    if (!history.complete || !approval.shown) {
      report.undetermined(
        'released_snapshot_unverified',
        taskKey,
        '引き受けた時の控えを確かめられない。',
      );
      continue;
    }
    const sourceUnknownAfterPurge =
      (approval.basisSourceIds === undefined || approval.basisItemIds === undefined) &&
      purgedSources.size > 0;
    const sourcePurged = approval.basisSourceIds?.some((id) => purgedSources.has(id)) ?? false;
    const until =
      sourcePurged || sourceUnknownAfterPurge
        ? undefined
        : (approval.shown.end ?? approval.shown.start);
    if (until && toEpochMinutes(until) <= toEpochMinutes(plan.now)) continue;
    report.violation('released_missing', taskKey, '不要になった引き受けが本人に示されていない。');
  }

  // 事業者に「もう要らない」を受け付けさせた後で同じ作業が戻った時は、
  // その前の承諾を確かめ直す（「まだ要るか」の知らせは取消しではない）。
  for (const task of plan.tasks) {
    if (!task.live || task.commitment !== 'accepted' || !task.assigneeId || task.reconfirm)
      continue;
    const approval = history.approvals.get(task.key);
    const acceptedAt = history.commitmentSeq.get(task.key);
    if (
      !approval ||
      approval.assigneeId !== task.assigneeId ||
      acceptedAt === undefined ||
      history.requestBasedDone.has(task.key)
    )
      continue;
    const base = `released:${task.key}:${task.assigneeId}`;
    const sent = history.events.some((event) => {
      if (
        event.type !== 'notified' ||
        event.actorId !== 'system' ||
        event.toMemberId !== task.assigneeId ||
        event.seq <= acceptedAt
      )
        return false;
      if (event.notificationKey === base) return true;
      const suffix = event.notificationKey.slice(base.length);
      return event.notificationKey.startsWith(base) && /^#\d+$/.test(suffix);
    });
    if (!sent) continue;
    const scope = executionScope(task, plan, household, history);
    if (!history.complete || scope === 'unknown')
      report.undetermined(
        'released_reconfirm_unverified',
        task.key,
        '知らせた後に作業が戻ったか確かめられない。',
      );
    else if (scope === 'active')
      report.violation(
        'released_reconfirm_missing',
        task.key,
        '不要と知らせた後の作業に、確かめ直しがない。',
      );
  }
}
