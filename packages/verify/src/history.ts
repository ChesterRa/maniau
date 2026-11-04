import type {
  DomainEvent,
  Household,
  Item,
  PlanResult,
  ProposalSnapshot,
  Task,
  TaskContent,
  Truth,
} from '@maniau/core';
import { Extraction, isNeedArrangementKey } from '@maniau/core';
import { collectFacts, type FactState, historicalItem, needShape } from './facts';
import { aboutMatches, sameValue } from './need-proof';
import { Collector } from './report';
import {
  instantMinute,
  localMinute,
  matchesArrangementDay,
  matchesArrangementWindow,
} from './time';

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

/** 済ませた用件と現在の用件を照らす。欄の順番は意味に含めない。 */
export function doneContentMatches(task: Task, content: TaskContent): boolean {
  const keys = Object.keys(task.titleParams);
  return (
    task.titleKey === content.titleKey &&
    task.about === content.about &&
    keys.length === Object.keys(content.titleParams).length &&
    keys.every(
      (key) =>
        Object.hasOwn(content.titleParams, key) &&
        task.titleParams[key] === content.titleParams[key],
    )
  );
}

export function sameBasis(
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

/** 依頼した「すること」の中身。日だけの締切に付いた内部の目安は内容にしない。 */
export function needContent(item: Item, timeZone: string): unknown[] {
  const value = item.interpretation;
  return [
    value.what ?? item.written,
    value.shape,
    value.date,
    value.startTime,
    value.endTime,
    value.startTimeUnconfirmed,
    value.endTimeUnconfirmed,
    value.deadlineDayOnly && value.deadline
      ? localMinute(instantMinute(value.deadline), timeZone).date
      : value.deadline,
    value.deadlineDayOnly,
    value.place,
    value.forMemberId,
  ];
}

interface Selection {
  primary?: string;
  backups: Set<string>;
  dropped: Set<string>;
}

type NeedWaysEvidence =
  | { state: 'current'; optionKeys: Set<string> }
  | { state: 'none' | 'unknown' };

export interface History {
  events: DomainEvent[];
  complete: boolean;
  /** 通用の手配の形。出典と事項の事象から得られない時は入れない。 */
  needShapes: Map<string, 'by' | 'window'>;
  /** 通用の依頼の控えが、送信時と今の双方の内容に一致するか。欄が無い物は未判定。 */
  needRequestCurrent: Map<string, boolean>;
  /** 送信時の控えが、その時の事項と登録済みのやり方に一致するか。 */
  needRequestSentValid: Map<string, boolean>;
  requests: Map<string, SentRequest>;
  selections: Map<string, Selection>;
  /** 家族のやり方の選びが現在の事項に対して有効か。空の選びも current として記録する。 */
  needWays: Map<string, NeedWaysEvidence>;
  approvals: Map<
    string,
    {
      assigneeId: string;
      seq: number;
      shown?: ProposalSnapshot;
      basisItemIds?: string[];
      basisSourceIds?: string[];
    }
  >;
  commitments: Map<string, string>;
  /** 最後の有効な担当・引き受け変更の通し番号。 */
  commitmentSeq: Map<string, number>;
  /** 本人が最後に「済んだ」と記録した時の用件。 */
  doneContents: Map<string, TaskContent>;
  /** 最後の有効な状態が、送信による済みになった作業。 */
  requestBasedDone: Set<string>;
}

/** 読み取りの作用などで同じ未定値が変わり得るなら、家族の答えだけでは確定できない。 */
export function otherAnswerPossible(events: readonly DomainEvent[], unknownId: string): boolean {
  return events.some((event) => {
    if (event.type === 'sourceContentPurged' && event.scope === 'all') return true;
    if (event.type !== 'modelOutputRecorded' || event.call !== 'extract') return false;
    const output = Extraction.safeParse(event.output);
    if (!output.success) return true;
    return (
      output.data.unknowns.some((unknown) => unknown.id === unknownId) ||
      output.data.items.some((item) =>
        item.effects.some(
          (effect) => effect.type === 'resolveUnknown' && effect.unknownId === unknownId,
        ),
      )
    );
  });
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
  const commitmentSeq = new Map<string, number>();
  const requestBasedDone = new Set<string>();
  const doneContents = new Map<string, TaskContent>();
  const commitmentChanges: { taskKey: string; state: string; seq: number; requestId?: string }[] =
    [];
  const correctedRequests = new Set<string>();
  const approvals = new Map<
    string,
    {
      assigneeId: string;
      seq: number;
      shown?: ProposalSnapshot;
      basisItemIds?: string[];
      basisSourceIds?: string[];
    }
  >();
  const requests = new Map<string, SentRequest>();
  const seenRequests = new Set<string>();
  const selections = new Map<string, Selection>();
  const wayChoices = new Map<string, Extract<DomainEvent, { type: 'needWaysSet' }>>();
  const excluded = new Set<string>();
  let householdAtTime: Household | undefined;
  for (const event of ordered) {
    if (event.householdId !== household.id) continue;
    if (event.type === 'householdSet') {
      const before = householdAtTime;
      const after = event.household;
      const changed =
        before &&
        (!sameValue(before.ways, after.ways) ||
          !sameValue(before.stoppedWayIds ?? [], after.stoppedWayIds ?? []));
      if (before && changed) {
        const actor = before.members.find((entry) => entry.id === event.actorId);
        if (actor?.kind !== 'adult' || !actor.active)
          report.violation(
            'way_edit_actor_invalid',
            event.id,
            'やり方を有効な大人以外が変更した。',
          );
        if (before.ways.some((way) => !after.ways.some((entry) => entry.id === way.id)))
          report.violation('way_removed', event.id, '過去の用件が参照するやり方を削除した。');
        const stopped = after.stoppedWayIds ?? [];
        if (
          new Set(stopped).size !== stopped.length ||
          stopped.some((id) => !after.ways.some((way) => way.id === id))
        )
          report.violation('stopped_way_invalid', event.id, 'やめたやり方の一覧が不正。');
        for (const way of after.ways) {
          const previous = before.ways.find((entry) => entry.id === way.id);
          if (previous && sameValue(previous, way)) continue;
          const unknown = way.cost.unknown ?? [];
          if (
            new Set(unknown).size !== unknown.length ||
            unknown.some((field) => way.cost[field] !== 0)
          )
            report.violation(
              'way_unknown_cost_invalid',
              event.id,
              '分からない代償の欄が重複するか、値を持っている。',
            );
        }
      }
      householdAtTime = after;
    }
    if (
      (event.type === 'notified' || event.type === 'sourceContentPurged') &&
      event.actorId !== 'system'
    ) {
      report.violation('system_event_actor_invalid', event.id, '仕組みだけが記録できる事象。');
      excluded.add(event.id);
      continue;
    }
    if (
      event.type === 'itemConfirmed' ||
      event.type === 'itemCorrected' ||
      event.type === 'itemDismissed' ||
      event.type === 'turnStated' ||
      event.type === 'escortStated' ||
      event.type === 'itemsStated' ||
      event.type === 'needWaysSet' ||
      event.type === 'sourceWithdrawn' ||
      event.type === 'transcriptionCorrected' ||
      event.type === 'requestRecordCorrected'
    ) {
      const member = householdAtTime?.members.find((entry) => entry.id === event.actorId);
      if (
        event.actorId === 'system' ||
        (householdAtTime && (member?.kind !== 'adult' || !member.active))
      ) {
        report.violation(
          'family_event_actor_invalid',
          event.id,
          '有効な大人だけが記録できる事象。',
        );
        excluded.add(event.id);
        continue;
      }
      if (!householdAtTime) {
        report.undetermined(
          'family_event_actor_unverified',
          event.id,
          'その時の成員を確認できない。',
        );
        excluded.add(event.id);
        continue;
      }
    }
    if (event.type === 'needWaysSet' && householdAtTime) {
      if (new Set(event.wayIds).size !== event.wayIds.length) {
        report.violation('need_way_duplicate', event.id, '同じやり方を重ねて選んでいる。');
        excluded.add(event.id);
        continue;
      }
      if (event.wayIds.some((id) => !householdAtTime?.ways.some((way) => way.id === id))) {
        report.violation('need_way_unknown', event.id, '選んだやり方がその時の家庭にない。');
        excluded.add(event.id);
        continue;
      }
      const stopped = event.wayIds.filter((id) => householdAtTime?.stoppedWayIds?.includes(id));
      if (stopped.length > 0) {
        const previous = wayChoices.get(event.itemId);
        if (!previous || stopped.some((id) => !previous.wayIds.includes(id))) {
          if (complete)
            report.violation('stopped_way_new_choice', event.id, 'やめたやり方を新たに選んだ。');
          else
            report.undetermined(
              'stopped_way_choice_unverified',
              event.id,
              '以前の選びを確認できない。',
            );
        } else {
          const prior = collectFacts(
            ordered.filter(
              (entry) =>
                entry.householdId === household.id &&
                entry.seq < event.seq &&
                !excluded.has(entry.id),
            ),
            new Collector(),
          );
          const item = prior.items.get(event.itemId);
          const ways = previous.wayIds.map((id) =>
            householdAtTime?.ways.find((way) => way.id === id),
          );
          const valid =
            item && ways.every((way) => way !== undefined)
              ? aboutMatches(
                  previous.about,
                  item,
                  ways.filter((way) => way !== undefined),
                )
              : undefined;
          if (valid === false)
            report.violation(
              'stopped_way_new_choice',
              event.id,
              '古くなった選びでやめたやり方を再び選んだ。',
            );
          else if (valid === undefined)
            report.undetermined(
              'stopped_way_choice_unverified',
              event.id,
              '以前の選びが今も有効か確認できない。',
            );
        }
      }
      wayChoices.set(event.itemId, event);
    }
    if (event.type === 'optionChosen') {
      if (event.actorId === 'system')
        report.violation('system_chose_option', event.id, '家族が選ぶ案を仕組みが選んでいる。');
      const oldSelection = selections.get(event.arrangementKey);
      if (householdAtTime && isNeedArrangementKey(event.arrangementKey)) {
        const stopped = householdAtTime.ways.some(
          (way) =>
            householdAtTime?.stoppedWayIds?.includes(way.id) &&
            event.optionKey === `opt:${event.arrangementKey}:${way.id}`,
        );
        const wasChosen =
          oldSelection?.primary === event.optionKey || oldSelection?.backups.has(event.optionKey);
        if (stopped && !wasChosen) {
          if (complete)
            report.violation(
              'stopped_way_new_option',
              event.id,
              'やめたやり方を本命・予備に新たに選んだ。',
            );
          else
            report.undetermined(
              'stopped_way_option_unverified',
              event.id,
              '以前に選んだ案か確認できない。',
            );
        }
      }
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
      commitmentChanges.push({ taskKey: event.taskKey, state: 'proposed', seq: event.seq });
      approvals.delete(event.taskKey);
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
      if (event.action === 'done' && event.content) doneContents.set(event.taskKey, event.content);
      else doneContents.delete(event.taskKey);
      if (event.action === 'accept') {
        approvals.set(event.taskKey, {
          assigneeId: event.assigneeId,
          seq: event.seq,
          ...(event.shown ? { shown: event.shown } : {}),
          ...(event.basisItemIds === undefined ? {} : { basisItemIds: event.basisItemIds }),
          ...(event.basisSourceIds === undefined ? {} : { basisSourceIds: event.basisSourceIds }),
        });
      } else approvals.delete(event.taskKey);
      const states = {
        accept: 'accepted',
        decline: 'declined',
        done: 'done',
        withdraw: 'withdrawn',
      } as const;
      commitmentChanges.push({
        taskKey: event.taskKey,
        state: states[event.action],
        seq: event.seq,
      });
    } else if (event.type === 'externalRequestSent') {
      if (seenRequests.has(event.requestId)) {
        report.violation('duplicate_request_sent', event.id, '同じ依頼 ID で複数回送っている。');
        continue;
      }
      seenRequests.add(event.requestId);
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
      commitmentChanges.push({
        taskKey: event.taskKey,
        state: 'done',
        seq: event.seq,
        requestId: event.requestId,
      });
    } else if (event.type === 'requestRecordCorrected') {
      const request = requests.get(event.requestId);
      if (!request) {
        if (complete)
          report.violation(
            'request_correction_without_send',
            event.id,
            '訂正する依頼の送信記録がない。',
          );
        else
          report.undetermined(
            'request_send_missing',
            event.id,
            '訂正する依頼の送信記録を確認できない。',
          );
      } else if (request.sentBy !== event.actorId) {
        report.violation(
          'request_correction_actor_mismatch',
          event.id,
          '送ったと記録した本人ではない。',
        );
      } else if (request.state !== 'awaitingReply') {
        report.violation(
          'request_correction_not_allowed',
          event.id,
          '返事または取消しの後に、送っていない事にはできない。',
        );
      } else {
        requests.delete(event.requestId);
        correctedRequests.add(event.requestId);
      }
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

  // 誤記を直した送信だけを除いて、引き受けの変遷をもう一度たどる。
  // 後の担当変更や別の送信を、誤記の直前の状態で上書きしない。
  for (const change of commitmentChanges) {
    if (change.requestId && correctedRequests.has(change.requestId)) continue;
    commitment.set(change.taskKey, change.state);
    commitmentSeq.set(change.taskKey, change.seq);
    if (change.requestId) requestBasedDone.add(change.taskKey);
    else requestBasedDone.delete(change.taskKey);
  }

  const usableEvents = ordered.filter(
    (event) => event.householdId === household.id && !excluded.has(event.id),
  );
  const needShapes = new Map<string, 'by' | 'window'>();
  const needWays = new Map<string, NeedWaysEvidence>();
  const needRequestCurrent = new Map<string, boolean>();
  const needRequestSentValid = new Map<string, boolean>();
  if (plan.arrangements.some((entry) => entry.kind === 'need')) {
    const factReport = new Collector();
    const facts = collectFacts(usableEvents, factReport);
    for (const arrangement of plan.arrangements) {
      const shape = needShape(arrangement, plan, facts);
      if (shape) needShapes.set(arrangement.key, shape);
      if (arrangement.kind !== 'need') continue;
      const requirement = plan.requirements.find(
        (entry) => entry.key === arrangement.requirementKey,
      );
      const itemId =
        requirement?.basis.itemIds.length === 1 ? requirement.basis.itemIds[0] : undefined;
      const item = itemId ? facts.items.get(itemId) : undefined;
      if (
        !complete ||
        factReport.issues.some((issue) => issue.kind === 'violation') ||
        !itemId ||
        item?.kind !== 'need' ||
        facts.staleItems.has(itemId) ||
        !['stated', 'confirmed'].includes(facts.needConfirmation.get(itemId) ?? '')
      ) {
        needWays.set(arrangement.key, { state: 'unknown' });
        continue;
      }
      const choice = usableEvents.findLast(
        (event) => event.type === 'needWaysSet' && event.itemId === itemId,
      );
      if (choice?.type !== 'needWaysSet') {
        needWays.set(arrangement.key, { state: 'none' });
        continue;
      }
      const priorReport = new Collector();
      const prior = collectFacts(
        usableEvents.filter((event) => event.seq < choice.seq),
        priorReport,
      );
      const previous = prior.items.get(itemId);
      const priorHousehold = usableEvents.findLast(
        (event) => event.type === 'householdSet' && event.seq < choice.seq,
      );
      const oldWays = choice.wayIds.map((id) =>
        priorHousehold?.type === 'householdSet'
          ? priorHousehold.household.ways.find((way) => way.id === id)
          : undefined,
      );
      const nowWays = choice.wayIds.map((id) => household.ways.find((way) => way.id === id));
      if (
        priorReport.issues.some((issue) => issue.kind === 'violation') ||
        previous?.kind !== 'need' ||
        prior.staleItems.has(itemId) ||
        priorHousehold?.type !== 'householdSet' ||
        oldWays.some((way) => !way) ||
        nowWays.some((way) => !way)
      ) {
        needWays.set(arrangement.key, { state: 'unknown' });
        continue;
      }
      const before = aboutMatches(
        choice.about,
        previous,
        oldWays.filter((way) => way !== undefined),
      );
      const current = aboutMatches(
        choice.about,
        item,
        nowWays.filter((way) => way !== undefined),
      );
      if (before !== true || current === undefined)
        needWays.set(arrangement.key, { state: 'unknown' });
      else if (!current) needWays.set(arrangement.key, { state: 'none' });
      else
        needWays.set(arrangement.key, {
          state: 'current',
          optionKeys: new Set([
            ...choice.wayIds.map((id) => `opt:${arrangement.key}:${id}`),
            ...arrangement.options
              .filter((option) => choice.wayIds.includes(option.templateId))
              .map((option) => option.key),
          ]),
        });
    }
    if (complete && !factReport.issues.some((issue) => issue.kind === 'violation')) {
      const priorBySeq = new Map<number, FactState>();
      for (const [requestId, sent] of requests) {
        const snapshot = sent.snapshot;
        const arrangement = plan.arrangements.find(
          (entry) => entry.key === snapshot?.basis.arrangementKey && entry.kind === 'need',
        );
        const requirement = plan.requirements.find(
          (entry) => entry.key === arrangement?.requirementKey,
        );
        const itemId =
          requirement?.basis.itemIds.length === 1 ? requirement.basis.itemIds[0] : undefined;
        const originalId =
          snapshot?.basis.itemIds.length === 1 ? snapshot.basis.itemIds[0] : undefined;
        const item = itemId ? facts.items.get(itemId) : undefined;
        const option = arrangement?.options.find(
          (entry) => entry.key === snapshot?.basis.optionKey,
        );
        // 選び直し待ちでは現在の options が空になる。送信時の案のキーは家庭に登録された ID を
        // 一つずつ当てて照らし、区切り文字で分解しない（ID 自体に ':' を含められる）。
        const ways = household.ways.filter((entry) =>
          option
            ? entry.id === option.templateId
            : snapshot?.basis.optionKey === `opt:${arrangement?.key}:${entry.id}`,
        );
        const way = ways.length === 1 ? ways[0] : undefined;
        const resolvedOriginal = originalId ? historicalItem(facts, originalId) : undefined;
        if (
          !snapshot ||
          !itemId ||
          !originalId ||
          item?.kind !== 'need' ||
          !way ||
          resolvedOriginal?.itemId !== itemId ||
          resolvedOriginal.active !== true ||
          facts.active.get(itemId) !== true ||
          facts.staleItems.has(itemId)
        )
          continue;
        let prior = priorBySeq.get(sent.seq);
        if (!prior) {
          const scratch = new Collector();
          const collected = collectFacts(
            usableEvents.filter((event) => event.seq < sent.seq),
            scratch,
          );
          if (scratch.issues.some((issue) => issue.kind === 'violation')) continue;
          prior = collected;
          priorBySeq.set(sent.seq, prior);
        }
        const old = prior.items.get(originalId);
        const oldHousehold = usableEvents.findLast(
          (event) => event.type === 'householdSet' && event.seq < sent.seq,
        );
        const oldWay =
          oldHousehold?.type === 'householdSet'
            ? oldHousehold.household.ways.find((entry) => entry.id === way.id)
            : undefined;
        if (
          old?.kind !== 'need' ||
          !oldWay ||
          prior.active.get(originalId) !== true ||
          prior.staleItems.has(originalId)
        )
          continue;
        const before = aboutMatches(snapshot.about, old, [oldWay]);
        const current = aboutMatches(snapshot.about, item, [way]);
        if (before !== undefined) needRequestSentValid.set(requestId, before);
        if (before === false || current === false) needRequestCurrent.set(requestId, false);
        else if (before === true && current === true) needRequestCurrent.set(requestId, true);
      }
    }
  }
  for (const arrangement of plan.arrangements) {
    if (!arrangement.live) continue;
    const selection = selections.get(arrangement.key);
    const evidence = needWays.get(arrangement.key);
    // 現在有効な選びを証明できる場合は事象から照らす。それ以外は、提示された案との整合を照らす。
    const allowed =
      evidence?.state === 'current'
        ? evidence.optionKeys
        : evidence?.state === 'none'
          ? new Set<string>()
          : new Set(arrangement.options.map((option) => option.key));
    const expectedPrimary =
      selection?.primary && allowed.has(selection.primary) ? selection.primary : undefined;
    const expectedBackups = [...(selection?.backups ?? [])]
      .filter((key) => allowed.has(key))
      .sort();
    const actualBackups = [...arrangement.backupOptionKeys].sort();
    if (
      arrangement.chosenOptionKey !== expectedPrimary ||
      JSON.stringify(actualBackups) !== JSON.stringify(expectedBackups)
    ) {
      if (complete && evidence?.state !== 'unknown')
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
    } else if (evidence?.state === 'unknown' && (selection?.primary || selection?.backups.size)) {
      report.undetermined(
        'option_selection_unknown',
        arrangement.key,
        '本命・予備の選択を事象から確定できない。',
      );
    }
  }
  const tasks = new Map(plan.tasks.map((task) => [task.key, task]));
  for (const task of plan.tasks) {
    const completed = doneContents.get(task.key);
    if (
      commitment.get(task.key) === 'done' &&
      !requestBasedDone.has(task.key) &&
      completed &&
      !doneContentMatches(task, completed)
    ) {
      // 前の用件を済ませた記録は、今の用件の済みではない。再確認の必要も後で検査する。
      commitment.set(task.key, 'accepted');
    }
    // 子の居場所の依頼で済んだ時、送った日の控えと今の手配の日を家庭の時区で照らす。
    // 控えのない古い送信は、今の日かを断定せず、今までの済みをそのまま見る。
    if (commitment.get(task.key) === 'done' && requestBasedDone.has(task.key)) {
      const arrangement = plan.arrangements.find(
        (entry) =>
          entry.key === task.basis.arrangementKey &&
          (entry.kind === 'childCare' || entry.kind === 'need'),
      );
      const seq = commitmentSeq.get(task.key);
      const sentEntry = [...requests.entries()].find(
        ([, entry]) => entry.taskKey === task.key && entry.seq === seq,
      );
      const sent = sentEntry?.[1];
      if (arrangement && sent) {
        const sameDay = matchesArrangementDay(
          sent.snapshot?.window,
          arrangement,
          household.timeZone,
          needShapes.get(arrangement.key),
        );
        const content = sentEntry ? needRequestCurrent.get(sentEntry[0]) : undefined;
        if (
          sameDay === false ||
          (arrangement.kind === 'need' && content === false) ||
          (sent.state === 'cancelled' && task.live && arrangement.live)
        )
          commitment.set(task.key, 'accepted');
        else if (sameDay === undefined)
          report.undetermined(
            'request_window_unverified',
            task.key,
            '送った依頼の日を確かめられない。',
          );
        else if (arrangement.kind === 'need' && content === undefined)
          report.undetermined(
            'need_request_content_unverified',
            task.key,
            '送った時と今の用件を確かめられない。',
          );
      }
    }
    // 買った後に同じ品物が無いと分かった時、購入の済みは今の用意の済みではない。
    // 事象と通し番号で照らし、読み取りの作用などが入り得る時は断定しない。
    let reopenUncertain = false;
    if (commitment.get(task.key) === 'done' && task.titleKey === 'task.buy') {
      const requirement = plan.requirements.find(
        (entry) => entry.key === task.basis.requirementKey && entry.kind === 'belongings',
      );
      const prefix = 'req:belongings:';
      const root = requirement?.key.startsWith(prefix) ? requirement.key.slice(prefix.length) : '';
      const unknownId = root ? `u-atHome:${root}` : '';
      if (
        requirement &&
        unknownId &&
        requirement.atHomeUnknownId === unknownId &&
        task.key === `task:opt:arr:purchase:${root}:buy:buy` &&
        task.titleParams.what === requirement.what
      ) {
        const answer = usableEvents.findLast(
          (entry) => entry.type === 'answered' && entry.unknownId === unknownId,
        );
        const doneSeq = commitmentSeq.get(task.key);
        if (
          answer?.type === 'answered' &&
          answer.value === 'no' &&
          (answer.about === undefined || answer.about === requirement.what) &&
          doneSeq !== undefined &&
          answer.seq > doneSeq
        ) {
          const family = usableEvents.findLast(
            (entry) => entry.type === 'householdSet' && entry.seq <= answer.seq,
          );
          const member =
            family?.type === 'householdSet'
              ? family.household.members.find((entry) => entry.id === answer.actorId)
              : undefined;
          if (
            member?.kind === 'adult' &&
            member.active &&
            !otherAnswerPossible(usableEvents, unknownId)
          )
            commitment.set(task.key, 'accepted');
          else reopenUncertain = true;
        }
      }
    }
    const expected = commitment.get(task.key);
    if (reopenUncertain && expected === task.commitment)
      report.undetermined(
        'commitment_state_unknown',
        task.key,
        '購入の後の答えを独立に確かめられない。',
      );
    if (!expected && task.commitment !== 'proposed' && task.commitment !== 'cancelled') {
      report.undetermined(
        'commitment_evidence_missing',
        task.key,
        '引き受け状態を事象から確認できない。',
      );
    } else if (expected && task.commitment !== 'cancelled' && expected !== task.commitment) {
      if (complete && !reopenUncertain)
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
    if (original?.window && request.window) {
      if (
        instantMinute(original.window.start) !== instantMinute(request.window.start) ||
        instantMinute(original.window.end) !== instantMinute(request.window.end)
      )
        report.violation(
          'request_window_mismatch',
          request.requestId,
          '依頼の期間が送った時の控えと違う。',
        );
    } else if (request.window && sent) {
      report.violation(
        'request_window_without_snapshot',
        request.requestId,
        '送信の控えにない期間が依頼に置かれている。',
      );
    } else if (original?.window || request.window) {
      report.undetermined(
        'request_window_unverified',
        request.requestId,
        '依頼の期間を送った時の控えと照らせない。',
      );
    }
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
    events: usableEvents,
    complete,
    needShapes,
    needRequestCurrent,
    needRequestSentValid,
    requests,
    selections,
    needWays,
    approvals,
    commitments: commitment,
    commitmentSeq,
    doneContents,
    requestBasedDone,
  };
}

/** 依頼時の控えと確かめた読み取り、再読後の未確認または読み落としを事象から照らす。 */
function pendingNeedProof(
  plan: PlanResult,
  history: History,
  facts: FactState,
  sent: SentRequest | undefined,
  basis: NonNullable<RequestBasis>['basis'],
):
  | {
      id: string;
      sourceId: string;
      arrangementKey: string;
      optionKey: string;
      wayId: string;
      after: DomainEvent[];
    }
  | undefined {
  if (!history.complete || !sent?.snapshot || !sameBasis(sent.snapshot.basis, basis))
    return undefined;
  if (sent.state !== 'awaitingReply' && sent.state !== 'confirmed') return undefined;
  const { arrangementKey, optionKey, itemIds } = sent.snapshot.basis;
  const id = itemIds.length === 1 ? itemIds[0] : undefined;
  if (!id || !arrangementKey || !optionKey) return undefined;
  if (plan.arrangements.some((entry) => entry.key === arrangementKey && entry.live))
    return undefined;
  const beforeEvents = history.events.filter((event) => event.seq < sent.seq);
  const priorReport = new Collector();
  const prior = collectFacts(beforeEvents, priorReport);
  if (priorReport.issues.some((issue) => issue.kind === 'violation')) return undefined;
  const previous = prior.items.get(id);
  const household = beforeEvents.findLast((event) => event.type === 'householdSet');
  if (
    previous?.kind !== 'need' ||
    previous.conditionNodeId !== undefined ||
    prior.needConfirmation.get(id) !== 'confirmed' ||
    prior.active.get(id) !== true ||
    prior.staleItems.has(id) ||
    household?.type !== 'householdSet'
  )
    return undefined;
  const current = facts.items.get(id);
  const absentAfterReread =
    current === undefined && (facts.sourceReadingSeq.get(previous.sourceId) ?? -1) > sent.seq;
  if (
    !absentAfterReread &&
    (current?.kind !== 'need' ||
      current.sourceId !== previous.sourceId ||
      current.conditionNodeId !== undefined ||
      facts.needConfirmation.get(id) !== 'pending' ||
      facts.active.get(id) !== 'unknown' ||
      facts.staleItems.has(id))
  )
    return undefined;
  if ((facts.changes.get(id)?.length ?? 0) > 0) return undefined;
  const after = history.events.filter((event) => event.seq > sent.seq);
  if (
    after.some((event) => {
      if (event.type === 'itemDismissed' || event.type === 'itemCorrected')
        return event.itemId === id;
      if (event.type === 'sourceWithdrawn' || event.type === 'sourceContentPurged')
        return event.sourceId === previous.sourceId;
      if (event.type === 'externalRequestSent') return event.taskKey === sent.taskKey;
      if (event.type === 'modelOutputRecorded' && event.call === 'extract') {
        const parsed = Extraction.safeParse(event.output);
        return (
          !parsed.success ||
          parsed.data.items.some((entry) =>
            entry.effects.some(
              (effect) => effect.type !== 'resolveUnknown' && effect.itemId === id,
            ),
          )
        );
      }
      return false;
    })
  )
    return undefined;
  const ways = household.household.ways.filter(
    (way) => optionKey === `opt:${arrangementKey}:${way.id}`,
  );
  const way = ways.length === 1 ? ways[0] : undefined;
  if (!way || aboutMatches(sent.snapshot.about, previous, [way]) !== true) return undefined;
  return { id, sourceId: previous.sourceId, arrangementKey, optionKey, wayId: way.id, after };
}

/** 再読前に引き続き選ばれていた依頼は、続けるかを本人に確かめる。 */
function pendingReadStanding(
  history: History,
  proof: ReturnType<typeof pendingNeedProof>,
): boolean {
  if (!proof || history.selections.get(proof.arrangementKey)?.primary !== proof.optionKey)
    return false;
  return !proof.after.some((event) => {
    if (event.type === 'needWaysSet') return event.itemId === proof.id;
    if (event.type === 'optionChosen' || event.type === 'optionDropped')
      return event.arrangementKey === proof.arrangementKey;
    return false;
  });
}

/** 再読前に家族が明示して外した選びを、未確認の読み取りで復活させない。 */
function pendingReadRemoved(
  history: History,
  facts: FactState,
  proof: ReturnType<typeof pendingNeedProof>,
): boolean {
  if (!proof) return false;
  const choice = proof.after.findLast(
    (event) => event.type === 'needWaysSet' && event.itemId === proof.id,
  );
  if (choice?.type !== 'needWaysSet' || choice.wayIds.includes(proof.wayId)) return false;
  if ((facts.sourceReadingSeq.get(proof.sourceId) ?? -1) <= choice.seq) return false;
  if (
    proof.after.some(
      (event) =>
        event.seq > choice.seq &&
        (event.type === 'optionChosen' || event.type === 'optionDropped') &&
        event.arrangementKey === proof.arrangementKey,
    )
  )
    return false;
  const beforeEvents = history.events.filter((event) => event.seq < choice.seq);
  const report = new Collector();
  const prior = collectFacts(beforeEvents, report);
  const item = prior.items.get(proof.id);
  const household = beforeEvents.findLast((event) => event.type === 'householdSet');
  if (
    report.issues.some((issue) => issue.kind === 'violation') ||
    item?.kind !== 'need' ||
    item.sourceId !== proof.sourceId ||
    prior.needConfirmation.get(proof.id) !== 'confirmed' ||
    prior.active.get(proof.id) !== true ||
    prior.staleItems.has(proof.id) ||
    household?.type !== 'householdSet'
  )
    return false;
  const ways = choice.wayIds.map((id) => household.household.ways.find((way) => way.id === id));
  return (
    ways.every((way) => way !== undefined) &&
    aboutMatches(
      choice.about,
      item,
      ways.filter((way) => way !== undefined),
    ) === true
  );
}

/** 依頼の必要性を、事象による選択と元の事項から計画の live とは別に確かめる。 */
export function checkRequestNeed(
  plan: PlanResult,
  history: History,
  facts: FactState,
  report: Collector,
  timeZone: string,
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
        const ways = history.needWays.get(basis.arrangementKey);
        if (selection?.dropped.has(basis.optionKey)) optionNeeded = false;
        else if (ways?.state === 'current' && !ways.optionKeys.has(basis.optionKey))
          // 現在の選びに無いだけでは、依頼した案の正体は分からない。送信時の控えとやり方を
          // 独立に確認できる時だけ、そのやり方が家族に外されたとする。
          optionNeeded =
            sent?.snapshot &&
            sameBasis(sent.snapshot.basis, request.basis) &&
            history.needRequestSentValid.get(request.requestId) === true
              ? false
              : 'unknown';
        else if (ways?.state === 'unknown') optionNeeded = 'unknown';
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
          const primaryRequests = [...history.requests.entries()].filter(([, sent]) =>
            primaryTasks.has(sent.taskKey),
          );
          const currentArrangement = plan.arrangements.find((a) => a.key === basis.arrangementKey);
          const current = currentArrangement
            ? primaryRequests.filter(
                ([id, sent]) =>
                  sent.state !== 'cancelled' &&
                  matchesArrangementDay(
                    sent.snapshot?.window,
                    currentArrangement,
                    timeZone,
                    history.needShapes.get(currentArrangement.key),
                  ) === true &&
                  (currentArrangement.kind !== 'need' ||
                    history.needRequestCurrent.get(id) !== false),
              )
            : [];
          const unknownWindow =
            currentArrangement &&
            primaryRequests.some(
              ([id, sent]) =>
                ['confirmed', 'awaitingReply', 'turnedDown'].includes(sent.state) &&
                (matchesArrangementDay(
                  sent.snapshot?.window,
                  currentArrangement,
                  timeZone,
                  history.needShapes.get(currentArrangement.key),
                ) === undefined ||
                  (currentArrangement.kind === 'need' &&
                    history.needRequestCurrent.get(id) === undefined)),
            );
          if (!currentArrangement || unknownWindow) optionNeeded = 'unknown';
          else if (
            current.length > 0 &&
            current.every(
              ([id, sent]) =>
                sent.state === 'confirmed' &&
                (currentArrangement.kind !== 'need' ||
                  history.needRequestCurrent.get(id) === true) &&
                !plan.requests.some((request) => request.requestId === id && request.needsCheck),
            )
          ) {
            // 見せる計画に本命の依頼が欠ける・不要とされている時は、予備を要らないと断定しない。
            const projected = current.map(([id]) =>
              plan.requests.find((request) => request.requestId === id),
            );
            optionNeeded = projected.every((request) => request?.live) ? false : 'unknown';
          }
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
    // 同じ作業から現在の日の依頼を新たに送ったなら、古い日の依頼は引き継がれない。
    // 古い控えに日が無い場合は、何日の依頼か分からないため、ここでは断定しない。
    const arrangement = plan.arrangements.find((entry) => entry.key === basis.arrangementKey);
    const superseded =
      history.complete &&
      sent !== undefined &&
      (arrangement?.kind === 'childCare' ||
        (arrangement?.kind === 'need' && history.needShapes.get(arrangement.key) === 'window')) &&
      matchesArrangementDay(
        sent.snapshot?.window,
        arrangement,
        timeZone,
        history.needShapes.get(arrangement.key),
      ) === false &&
      [...history.requests.values()].some(
        (newer) =>
          newer.taskKey === sent.taskKey &&
          newer.seq > sent.seq &&
          newer.state !== 'cancelled' &&
          matchesArrangementDay(
            newer.snapshot?.window,
            arrangement,
            timeZone,
            history.needShapes.get(arrangement.key),
          ) === true,
      );
    const pendingProof = pendingNeedProof(plan, history, facts, sent, request.basis);
    const removedBeforeReread = pendingReadRemoved(history, facts, pendingProof);
    const needed: Truth =
      superseded || optionNeeded === false || factsNeeded === false || removedBeforeReread
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
    const pending = pendingReadStanding(history, pendingProof);
    if (pending && !request.live)
      report.violation(
        'request_liveness_mismatch',
        request.requestId,
        '再読を確かめる前に依頼を不要と扱っている。',
      );
    if (pending && request.live && !request.needsCheck)
      report.violation(
        'request_uncertainty_unmarked',
        request.requestId,
        '再読後の依頼が要確認になっていない。',
      );
    if (pending && cancellations.length > 0)
      report.violation(
        'unexpected_cancellation',
        request.requestId,
        '再読を確かめる前に依頼の取消しを出している。',
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
    const requestedArrangement = plan.arrangements.find(
      (entry) => entry.key === basis.arrangementKey && entry.live,
    );
    if (
      needed !== false &&
      sent &&
      request.live &&
      requestedArrangement?.kind === 'need' &&
      (state === 'awaitingReply' || state === 'confirmed')
    ) {
      const proof = history.needRequestCurrent.get(request.requestId);
      if (proof === undefined)
        report.undetermined(
          'need_request_content_unverified',
          request.requestId,
          '送った時と今の用件・やり方を確かめられない。',
        );
      else if (!proof && !request.needsCheck)
        report.violation(
          'request_uncertainty_unmarked',
          request.requestId,
          '送った時と今の用件・やり方が異なるが、要確認になっていない。',
        );
    }
    if (
      sent !== undefined &&
      request.live &&
      (state === 'awaitingReply' || state === 'confirmed') &&
      (requestedArrangement?.kind === 'childCare' ||
        (requestedArrangement?.kind === 'need' &&
          history.needShapes.get(requestedArrangement.key) === 'window')) &&
      !sent.snapshot?.window
    )
      report.undetermined(
        'request_window_unverified',
        request.requestId,
        '控えが無いため、送った依頼の日を確かめられない。',
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
      const arrangement = plan.arrangements.find(
        (entry) => entry.key === basis.arrangementKey && entry.live,
      );
      const changedWindow =
        (arrangement?.kind === 'childCare' ||
          (arrangement?.kind === 'need' && history.needShapes.get(arrangement.key) === 'window')) &&
        original.window !== undefined &&
        matchesArrangementWindow(original.window, arrangement) === false;
      const currentItems = basis.itemIds.map((id) =>
        facts.items.get(historicalItem(facts, id).itemId),
      );
      const missingOrUntrusted = currentItems.some(
        (item) => !item || item.evidence === 'inferred' || item.evidence === 'conflicting',
      );
      const staleBasis = currentItems.some((item) => item && facts.staleItems.has(item.id));
      // 同じ節点 ID の再利用だけでは条件が同じとは限らない。送信前の読み取りを事象から作り直し、
      // 一つの未定値について別の値を指す条件に変わったケースだけ、意味の変更を確定する。
      let changedEquality = false;
      let changedNeed = false;
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
          if (arrangement?.kind === 'need') {
            changedNeed = basis.itemIds.some((id) => {
              const old = previous.items.get(id);
              const current = facts.items.get(historicalItem(facts, id).itemId);
              return (
                old?.kind === 'need' &&
                current?.kind === 'need' &&
                !previous.staleItems.has(id) &&
                !facts.staleItems.has(current.id) &&
                JSON.stringify(needContent(old, timeZone)) !==
                  JSON.stringify(needContent(current, timeZone))
              );
            });
          }
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
        changedNeed ||
        changedWindow ||
        (needed === 'unknown' &&
          (missingOrUntrusted ||
            staleBasis ||
            (original.conditional === false && request.conditional === true)))
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
