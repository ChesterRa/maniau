// 敏感な中身を事象から分ける（乾かす）・戻す（02-foundation §6.2）。core のエンジンと試験は、中身の
// 入った事象を扱い、保存の分け方を知らない。事象に残すのは、種類ごとの許す一覧の欄だけで、一覧に
// 無い欄はすべて payloads に置く（足した欄が、黙って事象に残らないように）。
import { DomainEvent } from '@maniau/core';
import { sha256Of } from '../digest';

type Fields = Record<string, unknown>;

/** 表の列に置く封筒の欄（本体には入れない）。 */
const ENVELOPE = new Set([
  'id',
  'householdId',
  'seq',
  'version',
  'occurredAt',
  'recordedAt',
  'actorId',
  'type',
]);

/**
 * 事象に残す欄（§6.2 の許す一覧）。「欄.中の欄」は、入れ子の中で残す欄。ID・時刻・決まった種類の
 * 符号だけで、名前や文や値は残さない。
 */
const KEEP: Record<DomainEvent['type'], readonly string[]> = {
  householdSet: [],
  noticeReceived: [
    'source.id',
    'source.version',
    'source.receivedAt',
    'source.sender',
    'source.senderPlaceId',
    'source.language',
    'source.medium',
    'source.correctsSourceId',
  ],
  modelOutputRecorded: ['call', 'model', 'promptVersion', 'sourceId', 'sourceVersion'],
  answered: ['unknownId'],
  optionChosen: ['arrangementKey', 'optionKey', 'role'],
  optionDropped: ['arrangementKey', 'optionKey'],
  assignmentProposed: ['taskKey', 'assigneeId'],
  commitmentChanged: ['taskKey', 'assigneeId', 'action', 'basisItemIds', 'basisSourceIds'],
  externalRequestSent: ['taskKey', 'requestId', 'snapshot.to', 'snapshot.kind', 'snapshot.basis'],
  externalReplyRecorded: ['requestId', 'reply'],
  cancellationSent: ['requestId'],
  requestRecordCorrected: ['requestId'],
  notified: ['notificationKey', 'toMemberId', 'channel', 'result', 'kind'],
  itemConfirmed: ['itemId'],
  itemCorrected: ['itemId'],
  itemDismissed: ['itemId', 'reason'],
  // うちの番かと、言った時の用件・対象（名前の入りうる文）は、payloads に置く。
  turnStated: ['itemId'],
  // 送り迎えの要否と、言った時の子・用件・日・時刻・場所は、payloads に置く。
  escortStated: ['itemId', 'leg'],
  sourceWithdrawn: ['sourceId'],
  sourceContentPurged: ['sourceId', 'scope'],
  transcriptionCorrected: ['sourceId', 'sourceVersion'],
  clockAdvanced: ['to'],
};

export interface DriedEvent {
  row: {
    seq: number;
    id: string;
    type: string;
    version: number;
    occurredAt: string;
    recordedAt: string;
    actorId: string;
    body: Fields;
  };
  /** 敏感な中身。無ければ、その事象は中身を持たない。 */
  payload?: { id: string; kind: string; sha256: string; body: Fields };
}

/** 事象の中身の ID（事象の ID から作る。中身を含まない）。 */
export const payloadIdOf = (eventId: string) => `${eventId}:payload`;

const isObject = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 事象を、表の行（許した欄）と中身に分ける。 */
export function dehydrate(event: DomainEvent): DriedEvent {
  const keep = KEEP[event.type];
  const top = new Set(keep.filter((k) => !k.includes('.')));
  const nested = new Map<string, Set<string>>();
  for (const path of keep.filter((k) => k.includes('.'))) {
    const [outer = '', inner = ''] = path.split('.');
    nested.set(outer, (nested.get(outer) ?? new Set()).add(inner));
  }
  const kept: Fields = {};
  const secret: Fields = {};
  for (const [key, value] of Object.entries(event)) {
    if (ENVELOPE.has(key) || value === undefined) continue;
    const inner = nested.get(key);
    if (top.has(key)) kept[key] = value;
    else if (inner && isObject(value)) {
      const keptInner: Fields = {};
      const secretInner: Fields = {};
      for (const [k, v] of Object.entries(value)) {
        if (v === undefined) continue;
        if (inner.has(k)) keptInner[k] = v;
        else secretInner[k] = v;
      }
      kept[key] = keptInner;
      if (Object.keys(secretInner).length > 0) secret[key] = secretInner;
    } else secret[key] = value;
  }
  const row = {
    seq: event.seq,
    id: event.id,
    type: event.type,
    version: event.version,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    actorId: event.actorId,
    body: kept,
  };
  if (Object.keys(secret).length === 0) return { row };
  return {
    row,
    payload: {
      id: payloadIdOf(event.id),
      kind: event.type,
      sha256: sha256Of(secret),
      body: secret,
    },
  };
}

/** 中身が消されていて、事象を戻せない（§6.3。消した印付きの事象は、削除の仕事と一緒に足す）。 */
export class PayloadGone extends Error {
  constructor(readonly eventId: string) {
    super(`事象の中身が無い：${eventId}`);
  }
}

/**
 * 中身が、書いた時の sha256 と合わない（壊れた）。偶然の損ないを見つけるだけで、中身とハッシュを
 * 一緒に書き換えた物は見つけられない（改ざんを防ぐ約束ではない）。
 */
export class PayloadCorrupt extends Error {
  constructor(readonly eventId: string) {
    super(`事象の中身が書いた時と違う：${eventId}`);
  }
}

/**
 * 表の行と中身から、事象を戻す。中身が無い・書いた時のハッシュと合わない・型に合わない時は投げる
 * （壊れた記録で計画を作らない）。sha256 は、中身と一緒に置いた値（試験で省ける）。
 */
export function rehydrate(
  householdId: string,
  row: DriedEvent['row'],
  payload: Fields | null | undefined,
  hasPayload: boolean,
  sha256?: string | null,
): DomainEvent {
  if (hasPayload && !payload) throw new PayloadGone(row.id);
  if (payload && sha256 !== undefined && sha256Of(payload) !== sha256) {
    throw new PayloadCorrupt(row.id);
  }
  const merged: Fields = { ...row.body };
  for (const [key, value] of Object.entries(payload ?? {})) {
    const current = merged[key];
    merged[key] = isObject(current) && isObject(value) ? { ...current, ...value } : value;
  }
  return DomainEvent.parse({
    ...merged,
    id: row.id,
    householdId,
    seq: row.seq,
    version: row.version,
    occurredAt: row.occurredAt,
    recordedAt: row.recordedAt,
    actorId: row.actorId,
    type: row.type,
  });
}
