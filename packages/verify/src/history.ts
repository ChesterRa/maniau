import type { DomainEvent, Household, PlanResult } from '@maniau/core';
import type { Collector } from './report';
import { instantMinute } from './time';

type RequestState = 'awaitingReply' | 'confirmed' | 'turnedDown' | 'cancelled';

interface SentRequest {
  taskKey: string;
  sentAt: string;
  sentBy: string;
  state: RequestState;
}

export interface History {
  events: DomainEvent[];
  complete: boolean;
  requests: Map<string, SentRequest>;
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
  const selections = new Map<string, { primary?: string; backups: Set<string> }>();
  for (const event of ordered) {
    if (event.householdId !== household.id) continue;
    if (event.type === 'optionChosen') {
      if (event.actorId === 'system')
        report.violation('system_chose_option', event.id, '家族が選ぶ案を仕組みが選んでいる。');
      const selection = selections.get(event.arrangementKey) ?? { backups: new Set<string>() };
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
    if (!request.live && (request.state === 'awaitingReply' || request.state === 'confirmed')) {
      const cancellations = plan.tasks.filter(
        (task) =>
          task.live &&
          task.cancels === request.requestId &&
          !['declined', 'withdrawn', 'cancelled'].includes(task.commitment),
      );
      if (cancellations.length === 0) {
        report.violation(
          'cancellation_missing',
          request.requestId,
          '不要になった依頼への取消しの連絡がない。',
        );
      } else if (cancellations.every((task) => task.commitment === 'done')) {
        report.undetermined(
          'cancellation_send_unverified',
          request.requestId,
          '取消し作業は済みだが、送った事象を確認できない。',
        );
      }
    }
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
  };
}
