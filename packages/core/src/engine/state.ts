// 事象の列を、計算に使う状態にたたむ（docs/design/01-model.md §2）。同じ列からは、いつも同じ状態になる。
import type { DomainEvent } from '../schema/events';
import type { Household } from '../schema/household';
import type { CommitmentState, ExternalRequestState } from '../schema/plan';
import { Extraction, type Item, type Source } from '../schema/source';
import { type DateTime, toEpochMinutes } from '../time';

export interface RequestRecord {
  requestId: string;
  taskKey: string;
  sentAt: DateTime;
  sentBy: string;
  state: ExternalRequestState;
}

export interface EngineState {
  household?: Household;
  sources: Map<string, Source>;
  /** 出典ごとの、検査を通った読み取り（後の物が前の物を置き換える）。 */
  extractions: Map<string, Extraction>;
  /** 未定の値の答え（家族の答えと、出典の作用）。後の物が勝つ。 */
  resolved: Map<string, { value: string; seq: number; by: 'family' | 'source' }>;
  primary: Map<string, string>;
  backups: Map<string, Set<string>>;
  /** 家族が取り下げた案（手配の key → 案の key）。頼んだ後なら、取り消しの連絡が要る。 */
  dropped: Map<string, Set<string>>;
  assignees: Map<string, string>;
  commitments: Map<string, CommitmentState>;
  requests: Map<string, RequestRecord>;
  notified: Set<string>;
  /** 時計（試験とデモで進めた時刻）。無ければ、呼ぶ側の now を使う。 */
  clock?: number;
  lastSeq: number;
  /** 使えなかったモデルの出力など、記録はあるが計算に入れなかった物。 */
  rejected: { seq: number; reason: string }[];
}

export function emptyState(): EngineState {
  return {
    sources: new Map(),
    extractions: new Map(),
    resolved: new Map(),
    primary: new Map(),
    backups: new Map(),
    dropped: new Map(),
    assignees: new Map(),
    commitments: new Map(),
    requests: new Map(),
    notified: new Set(),
    lastSeq: 0,
    rejected: [],
  };
}

export function foldEvents(events: readonly DomainEvent[]): EngineState {
  const state = emptyState();
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  for (const event of ordered) apply(state, event);
  return state;
}

function apply(state: EngineState, event: DomainEvent): void {
  state.lastSeq = Math.max(state.lastSeq, event.seq);
  switch (event.type) {
    case 'householdSet':
      state.household = event.household;
      return;
    case 'noticeReceived':
      state.sources.set(event.source.id, event.source);
      return;
    case 'modelOutputRecorded': {
      if (event.call !== 'extract') return;
      const parsed = Extraction.safeParse(event.output);
      if (!parsed.success) {
        state.rejected.push({ seq: event.seq, reason: '読み取りの出力が型に合わない' });
        return;
      }
      state.extractions.set(parsed.data.sourceId, parsed.data);
      for (const item of parsed.data.items) {
        for (const effect of item.effects) {
          if (effect.type === 'resolveUnknown') {
            state.resolved.set(effect.unknownId, {
              value: effect.value,
              seq: event.seq,
              by: 'source',
            });
          }
        }
      }
      return;
    }
    case 'answered':
      state.resolved.set(event.unknownId, { value: event.value, seq: event.seq, by: 'family' });
      return;
    case 'optionChosen':
      state.dropped.get(event.arrangementKey)?.delete(event.optionKey);
      if (event.role === 'primary') state.primary.set(event.arrangementKey, event.optionKey);
      else {
        const set = state.backups.get(event.arrangementKey) ?? new Set<string>();
        set.add(event.optionKey);
        state.backups.set(event.arrangementKey, set);
      }
      return;
    case 'optionDropped':
      if (state.primary.get(event.arrangementKey) === event.optionKey) {
        state.primary.delete(event.arrangementKey);
      }
      state.backups.get(event.arrangementKey)?.delete(event.optionKey);
      {
        const set = state.dropped.get(event.arrangementKey) ?? new Set<string>();
        set.add(event.optionKey);
        state.dropped.set(event.arrangementKey, set);
      }
      return;
    case 'assignmentProposed':
      state.assignees.set(event.taskKey, event.assigneeId);
      state.commitments.set(event.taskKey, 'proposed');
      return;
    case 'commitmentChanged': {
      // 本人だけが変えられる（§7）。本人でない操作は記録に残るが、状態は変えない。
      const assignee = state.assignees.get(event.taskKey) ?? event.assigneeId;
      if (event.actorId !== event.assigneeId || assignee !== event.assigneeId) {
        state.rejected.push({ seq: event.seq, reason: '本人でない人の引き受けの操作' });
        return;
      }
      state.assignees.set(event.taskKey, event.assigneeId);
      const next: Record<typeof event.action, CommitmentState> = {
        accept: 'accepted',
        decline: 'declined',
        done: 'done',
        withdraw: 'withdrawn',
      };
      state.commitments.set(event.taskKey, next[event.action]);
      return;
    }
    case 'externalRequestSent':
      state.requests.set(event.requestId, {
        requestId: event.requestId,
        taskKey: event.taskKey,
        sentAt: event.occurredAt,
        sentBy: event.actorId,
        state: 'awaitingReply',
      });
      state.commitments.set(event.taskKey, 'done');
      return;
    case 'externalReplyRecorded': {
      const request = state.requests.get(event.requestId);
      // 返事待ちから確定・断られたへ。相手の都合が変わった時（確定の後の「いいえ」、断った後の「はい」）も
      // 後の返事に従う。取り消した依頼は変えない。
      if (request && request.state !== 'cancelled') {
        request.state = event.reply === 'yes' ? 'confirmed' : 'turnedDown';
      }
      return;
    }
    case 'cancellationSent': {
      const request = state.requests.get(event.requestId);
      if (request) request.state = 'cancelled';
      return;
    }
    case 'notified':
      state.notified.add(event.notificationKey);
      return;
    case 'clockAdvanced':
      state.clock = toEpochMinutes(event.to);
      return;
  }
}

/** 今の事項（置き換え・取り消しされていない物）と、置き換えをたどった元の事項の ID。 */
export function currentItems(state: EngineState): { item: Item; rootId: string }[] {
  const all = [...state.extractions.values()].flatMap((e) => e.items);
  const replacedBy = new Map<string, string>();
  const cancelled = new Set<string>();
  for (const item of all) {
    for (const effect of item.effects) {
      if (effect.type === 'replace') replacedBy.set(effect.itemId, item.id);
      if (effect.type === 'cancel') cancelled.add(effect.itemId);
    }
  }
  const replaces = new Map<string, string>();
  for (const [oldId, newId] of replacedBy) replaces.set(newId, oldId);
  const rootOf = (id: string): string => {
    const seen = new Set<string>();
    let current = id;
    while (replaces.has(current) && !seen.has(current)) {
      seen.add(current);
      current = replaces.get(current) ?? current;
    }
    return current;
  };
  return all
    .filter((item) => !replacedBy.has(item.id) && !cancelled.has(item.id))
    .map((item) => ({ item, rootId: rootOf(item.id) }));
}
