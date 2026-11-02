import type { DomainEvent, Household, PlanResult, Truth } from '@maniau/core';
import type { FactState } from './facts';
import type { Collector } from './report';
import { instantMinute } from './time';

type RequestState = 'awaitingReply' | 'confirmed' | 'turnedDown' | 'cancelled';

interface SentRequest {
  taskKey: string;
  sentAt: string;
  sentBy: string;
  state: RequestState;
}

interface Selection {
  primary?: string;
  backups: Set<string>;
  dropped: Set<string>;
}

export interface History {
  events: DomainEvent[];
  complete: boolean;
  requests: Map<string, SentRequest>;
  selections: Map<string, Selection>;
}

/** 計画に含めた通し番号までだけを使う。欠けた列は、無かった事の証明にしない。 */
export function checkHistory(
  household: Household,
  plan: PlanResult,
  events: readonly DomainEvent[],
  report: Collector,
): History {
  const applicable = events.filter((event) => event.seq <= plan.throughSeq);
  const ordered = [...applicable].sort((a, b) => a.seq - b.seq);
  let complete = true;
  const sequences = new Set<number>();
  const ids = new Set<string>();
  for (const event of ordered) {
    if (event.householdId !== household.id) {
      report.violation('event_household_mismatch', event.id, '別の家庭の事象が混じっている。');
      complete = false;
    }
    if (sequences.has(event.seq) || ids.has(event.id)) {
      report.violation('duplicate_event', event.id, '事象 ID または通し番号が重複している。');
      complete = false;
    }
    sequences.add(event.seq);
    ids.add(event.id);
  }
  const first = ordered[0];
  const last = ordered.at(-1);
  if (plan.throughSeq > 0 && (!first || first.seq > 1 || last?.seq !== plan.throughSeq))
    complete = false;
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1];
    const current = ordered[i];
    if (previous && current && current.seq !== previous.seq + 1) complete = false;
  }
  if (!complete)
    report.undetermined(
      'event_history_incomplete',
      'events',
      '計画までの事象列が完全か確かめられない。',
    );

  const assignments = new Map<string, string>();
  const commitment = new Map<string, string>();
  const requests = new Map<string, SentRequest>();
  const selections = new Map<string, Selection>();
  for (const event of ordered) {
    if (event.householdId !== household.id) continue;
    if (event.type === 'optionChosen') {
      if (event.actorId === 'system')
        report.violation('system_chose_option', event.id, '家族が選ぶ案を仕組みが選んでいる。');
      const selection = selections.get(event.arrangementKey) ?? {
        backups: new Set<string>(),
        dropped: new Set<string>(),
      };
      selection.dropped.delete(event.optionKey);
      if (event.role === 'primary') {
        selection.primary = event.optionKey;
        selection.backups.delete(event.optionKey);
      } else {
        if (selection.primary === event.optionKey)
          report.violation('backup_is_primary', event.id, '本命を同時に予備として選んでいる。');
        selection.backups.add(event.optionKey);
      }
      selections.set(event.arrangementKey, selection);
    } else if (event.type === 'optionDropped') {
      const selection = selections.get(event.arrangementKey);
      if (!selection) {
        report.undetermined(
          'dropped_option_history_missing',
          event.id,
          'やめた案を選んだ事象を確認できない。',
        );
        selections.set(event.arrangementKey, {
          backups: new Set<string>(),
          dropped: new Set([event.optionKey]),
        });
      } else {
        if (selection.primary !== event.optionKey && !selection.backups.has(event.optionKey)) {
          if (complete)
            report.violation(
              'option_drop_without_choice',
              event.id,
              '選んでいない案をやめる事象がある。',
            );
          else
            report.undetermined(
              'dropped_option_history_missing',
              event.id,
              'やめた案を選んだ事象を確認できない。',
            );
        }
        if (selection.primary === event.optionKey) selection.primary = undefined;
        selection.backups.delete(event.optionKey);
        selection.dropped.add(event.optionKey);
      }
    } else if (event.type === 'assignmentProposed') {
      assignments.set(event.taskKey, event.assigneeId);
      commitment.set(event.taskKey, 'proposed');
    } else if (event.type === 'commitmentChanged') {
      if (event.actorId !== event.assigneeId) {
        report.violation(
          'commitment_actor_mismatch',
          event.id,
          '引き受けの操作を担当本人が行っていない。',
        );
      }
      const assigned = assignments.get(event.taskKey);
      if (assigned === undefined) {
        report.undetermined(
          'assignment_history_missing',
          event.id,
          'その時の担当を事象から確認できない。',
        );
      } else if (assigned !== event.assigneeId) {
        report.violation(
          'commitment_assignment_mismatch',
          event.id,
          '操作時の担当と事象に書かれた担当が違う。',
        );
      }
      // 本人でない操作は記録には残すが、状態を変えない。
      if (event.actorId !== event.assigneeId || (assigned && assigned !== event.assigneeId))
        continue;
      assignments.set(event.taskKey, event.assigneeId);
      const states = {
        accept: 'accepted',
        decline: 'declined',
        done: 'done',
        withdraw: 'withdrawn',
      } as const;
      commitment.set(event.taskKey, states[event.action]);
    } else if (event.type === 'externalRequestSent') {
      if (requests.has(event.requestId)) {
        report.violation('duplicate_request_sent', event.id, '同じ依頼 ID で複数回送っている。');
        continue;
      }
      const assigned = assignments.get(event.taskKey);
      if (assigned === undefined) {
        report.undetermined(
          'request_assignment_missing',
          event.id,
          '依頼を送った時の担当が分からない。',
        );
      } else if (assigned !== event.actorId) {
        report.violation(
          'request_actor_mismatch',
          event.id,
          '依頼を送った人が、その時の担当と違う。',
        );
      }
      requests.set(event.requestId, {
        taskKey: event.taskKey,
        sentAt: event.occurredAt,
        sentBy: event.actorId,
        state: 'awaitingReply',
      });
      commitment.set(event.taskKey, 'done');
    } else if (event.type === 'externalReplyRecorded' || event.type === 'cancellationSent') {
      const request = requests.get(event.requestId);
      if (!request) {
        if (complete)
          report.violation(
            'request_event_without_send',
            event.id,
            '送った記録のない依頼への返事・取消し。',
          );
        else report.undetermined('request_send_missing', event.id, '依頼を送った記録がない。');
      } else if (event.type === 'cancellationSent') {
        request.state = 'cancelled';
      } else if (request.state !== 'cancelled') {
        request.state = event.reply === 'yes' ? 'confirmed' : 'turnedDown';
      }
    }
  }

  for (const arrangement of plan.arrangements) {
    if (!arrangement.live) continue;
    const selection = selections.get(arrangement.key);
    const expectedPrimary = selection?.primary;
    const expectedBackups = [...(selection?.backups ?? [])].sort();
    const actualBackups = [...arrangement.backupOptionKeys].sort();
    if (
      arrangement.chosenOptionKey !== expectedPrimary ||
      JSON.stringify(actualBackups) !== JSON.stringify(expectedBackups)
    ) {
      if (complete)
        report.violation(
          'option_selection_mismatch',
          arrangement.key,
          '本命・予備の選択と事象が食い違う。',
        );
      else
        report.undetermined(
          'option_selection_unknown',
          arrangement.key,
          '本命・予備の選択を事象から確定できない。',
        );
    }
  }

  const tasks = new Map(plan.tasks.map((task) => [task.key, task]));
  for (const task of plan.tasks) {
    const expected = commitment.get(task.key);
    if (!expected && task.commitment !== 'proposed' && task.commitment !== 'cancelled') {
      report.undetermined(
        'commitment_evidence_missing',
        task.key,
        '引き受け状態を事象から確認できない。',
      );
    } else if (expected && task.commitment !== 'cancelled' && expected !== task.commitment) {
      if (complete)
        report.violation('commitment_state_mismatch', task.key, '引き受け状態と事象が食い違う。');
      else
        report.undetermined(
          'commitment_state_unknown',
          task.key,
          '引き受け状態と不完全な事象列が食い違う。',
        );
    }
    const assignee = assignments.get(task.key);
    if (
      assignee &&
      task.assigneeId &&
      assignee !== task.assigneeId &&
      task.commitment !== 'cancelled'
    ) {
      if (complete)
        report.violation('assignee_state_mismatch', task.key, '計画の担当と最後の提案が違う。');
      else
        report.undetermined('assignee_state_unknown', task.key, '担当と不完全な事象列が食い違う。');
    }
  }

  const plannedIds = new Set<string>();
  for (const request of plan.requests) {
    if (plannedIds.has(request.requestId))
      report.violation('duplicate_request', request.requestId, '計画の依頼 ID が重複している。');
    plannedIds.add(request.requestId);
    const sent = requests.get(request.requestId);
    if (!sent) {
      if (complete)
        report.violation('request_without_send', request.requestId, '依頼を送った事象がない。');
      else
        report.undetermined(
          'request_send_missing',
          request.requestId,
          '依頼を送った事象を確認できない。',
        );
    } else {
      if (
        sent.taskKey !== request.taskKey ||
        sent.sentBy !== request.sentBy ||
        instantMinute(sent.sentAt) !== instantMinute(request.sentAt)
      ) {
        report.violation(
          'request_sent_mismatch',
          request.requestId,
          '依頼の送信記録と計画が食い違う。',
        );
      }
      if (sent.state !== request.state) {
        if (complete)
          report.violation(
            'request_state_mismatch',
            request.requestId,
            '依頼の状態と事象が食い違う。',
          );
        else
          report.undetermined(
            'request_state_unknown',
            request.requestId,
            '依頼状態を事象から確定できない。',
          );
      }
    }
    const task = tasks.get(request.taskKey);
    if (!task) {
      report.undetermined(
        'request_task_missing',
        request.requestId,
        '依頼を送った作業が計画にない。',
      );
    } else if (
      !task.external ||
      task.external.to !== request.to ||
      task.external.kind !== request.kind
    ) {
      report.violation(
        'request_recipient_mismatch',
        request.requestId,
        '依頼の相手または種類が作業と違う。',
      );
    }
    if (
      task &&
      (task.basis.arrangementKey !== request.basis.arrangementKey ||
        task.basis.optionKey !== request.basis.optionKey ||
        task.basis.requirementKey !== request.basis.requirementKey ||
        JSON.stringify([...task.basis.itemIds].sort()) !==
          JSON.stringify([...request.basis.itemIds].sort()))
    )
      report.violation(
        'request_basis_mismatch',
        request.requestId,
        '依頼の根拠が送った作業と違う。',
      );
  }
  for (const [requestId, sent] of requests) {
    if (
      !plannedIds.has(requestId) &&
      (sent.state === 'awaitingReply' || sent.state === 'confirmed')
    ) {
      report.violation('active_request_missing', requestId, '返事待ち・確定中の依頼が計画にない。');
    }
  }
  for (const task of plan.tasks) {
    if (task.live && task.cancels && !plannedIds.has(task.cancels)) {
      report.undetermined('cancellation_target_missing', task.key, '取り消す依頼を確認できない。');
    }
  }
  return {
    events: ordered.filter((event) => event.householdId === household.id),
    complete,
    requests,
    selections,
  };
}

/** 依頼の必要性を、事象による選択と元の事項から計画の live とは別に確かめる。 */
export function checkRequestNeed(
  plan: PlanResult,
  history: History,
  facts: FactState,
  report: Collector,
): void {
  for (const request of plan.requests) {
    const source = plan.tasks.find((task) => task.key === request.taskKey);
    const basis = source?.basis ?? request.basis;
    let optionNeeded: Truth = true;
    if (basis.arrangementKey && basis.optionKey) {
      if (!history.complete) optionNeeded = 'unknown';
      else {
        const selection = history.selections.get(basis.arrangementKey);
        if (selection?.dropped.has(basis.optionKey)) optionNeeded = false;
        else if (!selection?.primary && !selection?.backups.size) optionNeeded = true;
        else if (selection.primary === basis.optionKey) optionNeeded = true;
        else if (!selection.backups.has(basis.optionKey)) optionNeeded = false;
        else if (selection.primary) {
          const primaryTasks = new Set(
            plan.tasks
              .filter(
                (task) =>
                  task.basis.arrangementKey === basis.arrangementKey &&
                  task.basis.optionKey === selection.primary,
              )
              .map((task) => task.key),
          );
          const primaryRequests = [...history.requests.values()].filter((sent) =>
            primaryTasks.has(sent.taskKey),
          );
          if (
            primaryRequests.length > 0 &&
            primaryRequests.every((sent) => sent.state === 'confirmed')
          )
            optionNeeded = false;
        }
      }
    } else if (basis.optionKey || basis.arrangementKey) optionNeeded = 'unknown';
    let factsNeeded: Truth = basis.itemIds.length ? true : 'unknown';
    for (const itemId of basis.itemIds) {
      const active = facts.active.get(itemId);
      if (active === false) {
        factsNeeded = false;
        break;
      }
      if (active === undefined || active === 'unknown') factsNeeded = 'unknown';
    }
    const needed: Truth =
      optionNeeded === false || factsNeeded === false
        ? false
        : optionNeeded === true && factsNeeded === true
          ? true
          : 'unknown';
    if (needed !== 'unknown' && needed !== request.live)
      report.violation(
        'request_liveness_mismatch',
        request.requestId,
        '依頼の必要性が選択または元の事項と違う。',
      );

    const cancellations = plan.tasks.filter(
      (task) =>
        task.live &&
        task.cancels === request.requestId &&
        !['declined', 'withdrawn', 'cancelled'].includes(task.commitment),
    );
    const sent = history.requests.get(request.requestId);
    const state = sent?.state ?? request.state;
    if (
      (needed === false || (needed === 'unknown' && !request.live)) &&
      (state === 'awaitingReply' || state === 'confirmed')
    ) {
      if (cancellations.length === 0)
        report.violation(
          'cancellation_missing',
          request.requestId,
          '不要になった依頼への取消しの連絡がない。',
        );
      else if (cancellations.every((task) => task.commitment === 'done'))
        report.undetermined(
          'cancellation_send_unverified',
          request.requestId,
          '取消し作業は済みだが、送った事象を確認できない。',
        );
    }
    // 根拠が不明でも、計画が必要とする依頼と同時に取消しを置くのは矛盾。
    if (
      (needed === true || (needed === 'unknown' && optionNeeded === true && request.live)) &&
      cancellations.length > 0
    )
      report.violation(
        'unexpected_cancellation',
        request.requestId,
        'まだ必要な依頼に取消しの連絡がある。',
      );
    if (
      (needed === true || (needed === 'unknown' && optionNeeded === true && request.live)) &&
      state === 'cancelled'
    )
      report.violation(
        'needed_request_cancelled',
        request.requestId,
        '必要な依頼が取り消されている。',
      );
    if (needed === 'unknown')
      report.undetermined(
        'request_need_unverified',
        request.requestId,
        '依頼の必要性を事象と元の事項から確定できない。',
      );
  }
}
