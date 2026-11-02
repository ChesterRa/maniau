import type { DomainEvent, Household, PlanResult, Truth } from '@maniau/core';
import { collectFacts, type FactState, historicalItem } from './facts';
import { Collector } from './report';
import { instantMinute } from './time';

type RequestState = 'awaitingReply' | 'confirmed' | 'turnedDown' | 'cancelled';

interface SentRequest {
  taskKey: string;
  seq: number;
  sentAt: string;
  sentBy: string;
  state: RequestState;
  snapshot?: Extract<DomainEvent, { type: 'externalRequestSent' }>['snapshot'];
}

type RequestBasis = Extract<DomainEvent, { type: 'externalRequestSent' }>['snapshot'];

function sameBasis(
  a: NonNullable<RequestBasis>['basis'],
  b: NonNullable<RequestBasis>['basis'],
): boolean {
  return (
    a.arrangementKey === b.arrangementKey &&
    a.optionKey === b.optionKey &&
    a.requirementKey === b.requirementKey &&
    JSON.stringify([...a.itemIds].sort()) === JSON.stringify([...b.itemIds].sort())
  );
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
        seq: event.seq,
        sentAt: event.occurredAt,
        sentBy: event.actorId,
        state: 'awaitingReply',
        ...(event.snapshot ? { snapshot: event.snapshot } : {}),
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
    // 送った時の控えは、現在の作業より優先する。変更後の作業から、過去の相手や根拠を作り直さない。
    const task = tasks.get(request.taskKey);
    const original = sent?.snapshot;
    if (original && (original.to !== request.to || original.kind !== request.kind)) {
      report.violation(
        'request_recipient_mismatch',
        request.requestId,
        '依頼の相手または種類が送った時の控えと違う。',
      );
    } else if (!original && !task) {
      report.undetermined(
        'request_task_missing',
        request.requestId,
        '送った時の控えも、依頼を送った作業も確認できない。',
      );
    } else if (
      !original &&
      task &&
      (!task.external || task.external.to !== request.to || task.external.kind !== request.kind)
    ) {
      report.violation(
        'request_recipient_mismatch',
        request.requestId,
        '依頼の相手または種類が作業と違う。',
      );
    }
    const originalBasis = original?.basis ?? task?.basis;
    if (originalBasis && !sameBasis(originalBasis, request.basis))
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
  const beforeSending = new Map<number, FactState>();
  for (const request of plan.requests) {
    const source = plan.tasks.find((task) => task.key === request.taskKey);
    const sent = history.requests.get(request.requestId);
    const basis = sent?.snapshot?.basis ?? source?.basis ?? request.basis;
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
    const basisStates = basis.itemIds.map((itemId) =>
      sent?.snapshot ? historicalItem(facts, itemId).active : facts.active.get(itemId),
    );
    // 複数の根拠の一部が外れただけでは、依頼全体が不要か分からない。
    const factsNeeded: Truth =
      basisStates.length === 0
        ? 'unknown'
        : basisStates.every((active) => active === false)
          ? false
          : basisStates.every((active) => active === true)
            ? true
            : 'unknown';
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
    const state = sent?.state ?? request.state;
    const partiallyCancelled =
      sent?.snapshot !== undefined &&
      history.complete &&
      optionNeeded === true &&
      basisStates.some((active) => active !== false) &&
      basis.itemIds.some((id) => {
        const resolved = historicalItem(facts, id);
        if (resolved.active !== false) return false;
        const changes = facts.changes.get(resolved.itemId) ?? [];
        const effective = changes.filter((change) => change.active === true);
        return (
          !changes.some((change) => change.active === 'unknown') &&
          effective.length === 1 &&
          effective[0]?.kind === 'cancel'
        );
      }) &&
      plan.arrangements.some((entry) => entry.key === basis.arrangementKey && entry.live);
    if (partiallyCancelled && !request.live && (state === 'awaitingReply' || state === 'confirmed'))
      report.violation(
        'request_liveness_mismatch',
        request.requestId,
        '根拠の一部だけが取り消された依頼を、確かめずに不要と扱っている。',
      );
    if (
      needed !== false &&
      history.complete &&
      sent?.snapshot &&
      request.live &&
      (state === 'awaitingReply' || state === 'confirmed') &&
      !request.needsCheck
    ) {
      const original = sent.snapshot;
      const currentItems = basis.itemIds.map((id) =>
        facts.items.get(historicalItem(facts, id).itemId),
      );
      const missingOrUntrusted = currentItems.some(
        (item) => !item || item.evidence === 'inferred' || item.evidence === 'conflicting',
      );
      // 同じ節点 ID の再利用だけでは条件が同じとは限らない。送信前の読み取りを事象から作り直し、
      // 一つの未定値について別の値を指す条件に変わったケースだけ、意味の変更を確定する。
      let changedEquality = false;
      const conditionDataInvalid = report.issues.some((issue) =>
        [
          'invalid_extraction',
          'duplicate_condition',
          'invalid_condition',
          'condition_graph_too_large',
          'unknown_values_conflict',
        ].includes(issue.code),
      );
      if (!conditionDataInvalid) {
        let previous = beforeSending.get(sent.seq);
        if (!previous) {
          const scratch = new Collector();
          const parsed = collectFacts(
            history.events.filter((event) => event.seq < sent.seq),
            scratch,
          );
          if (!scratch.issues.some((issue) => issue.kind === 'violation')) {
            beforeSending.set(sent.seq, parsed);
            previous = parsed;
          }
        }
        if (previous) {
          changedEquality = basis.itemIds.some((id) => {
            const oldId = previous.items.get(id)?.conditionNodeId;
            const newId = facts.items.get(historicalItem(facts, id).itemId)?.conditionNodeId;
            const oldNode = oldId ? previous.conditions.get(oldId) : undefined;
            const newNode = newId ? facts.conditions.get(newId) : undefined;
            const oldUnknown =
              oldNode?.kind === 'eq' ? previous.unknowns.get(oldNode.unknownId) : undefined;
            const newUnknown =
              newNode?.kind === 'eq' ? facts.unknowns.get(newNode.unknownId) : undefined;
            return (
              oldNode?.kind === 'eq' &&
              newNode?.kind === 'eq' &&
              oldNode.unknownId === newNode.unknownId &&
              oldNode.value !== newNode.value &&
              oldUnknown !== undefined &&
              newUnknown !== undefined &&
              JSON.stringify(oldUnknown) === JSON.stringify(newUnknown)
            );
          });
        }
      }
      if (
        partiallyCancelled ||
        changedEquality ||
        (needed === 'unknown' &&
          (missingOrUntrusted || (original.conditional === false && request.conditional === true)))
      ) {
        report.violation(
          'request_uncertainty_unmarked',
          request.requestId,
          '送った依頼の新たな不確かさを、要確認または条件付きとして示していない。',
        );
      } else if (
        needed === 'unknown' ||
        original.conditional === true ||
        currentItems.some((item) => item?.conditionNodeId !== undefined)
      ) {
        // 検証器の近似だけで unknown になった場合は、実際の新たな不確かさと断定できない。
        // 節点 ID が同じでも内容が変わり得るし、違っても同じ意味かもしれない。
        report.undetermined(
          'request_condition_history_unverified',
          request.requestId,
          '送った時の条件と、今の条件の意味が同じか確認できない。',
        );
      }
    }
    if (needed === false && (state === 'awaitingReply' || state === 'confirmed')) {
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
    if (needed === true && cancellations.length > 0)
      report.violation(
        'unexpected_cancellation',
        request.requestId,
        'まだ必要な依頼に取消しの連絡がある。',
      );
    if (needed === true && state === 'cancelled')
      report.violation(
        'needed_request_cancelled',
        request.requestId,
        '必要な依頼が取り消されている。',
      );
    if (needed === 'unknown') {
      report.undetermined(
        'request_need_unverified',
        request.requestId,
        '依頼の必要性を事象と元の事項から確定できない。',
      );
      if (cancellations.length > 0)
        report.undetermined(
          'cancellation_need_unverified',
          request.requestId,
          '取消しの要否を事象と元の事項から確定できない。',
        );
    }
  }
}
