// 事象（状態の正本）。追記だけの列で、今の状態はいつでも事象から作り直せる（docs/design/01-model.md §2）。
import { z } from 'zod';
import { DateTime } from '../time';
import { Household, Id } from './household';
import { Source } from './source';

/** 事象の共通の欄。 */
const envelope = {
  id: Id,
  householdId: Id,
  /** 家庭ごとの通し番号。 */
  seq: z.number().int().nonnegative(),
  /** 中身の版。 */
  version: z.literal(1),
  occurredAt: DateTime,
  recordedAt: DateTime,
  /** 操作した成員。仕組みが起こした物は system。 */
  actorId: Id,
};

/** モデルの呼び出しの種類（§10）。 */
export const ModelCall = z.enum([
  'extract',
  'inferPreparation',
  'interpretUtterance',
  'explain',
  'whatIf',
  'storeKind',
  'draftMessage',
]);
export type ModelCall = z.infer<typeof ModelCall>;

export const DomainEvent = z.discriminatedUnion('type', [
  /** 家族の情報を置いた・変えた（v0 は全体を置き換える）。 */
  z.object({ ...envelope, type: z.literal('householdSet'), household: Household }),
  /** おたよりが届いた。原文は、敏感な材料として分けた保管場所に置くこともある（§2）。 */
  z.object({ ...envelope, type: z.literal('noticeReceived'), source: Source }),
  /**
   * モデルの出力。再生の時にモデルを呼ばないために残す。
   * call が extract の時、output はコードの検査を通った Extraction（source.ts）である。
   */
  z.object({
    ...envelope,
    type: z.literal('modelOutputRecorded'),
    call: ModelCall,
    model: z.string().min(1),
    promptVersion: z.string().min(1),
    inputHash: z.string().min(1),
    sourceId: Id.optional(),
    /** 呼び出しの種類ごとの型で、使う時に検査する。 */
    output: z.unknown(),
  }),
  /** 問いに答えた（未定の値が決まった）。 */
  z.object({ ...envelope, type: z.literal('answered'), unknownId: Id, value: z.string().min(1) }),
  /** 家族が手配の案を選んだ。本命か、本命の返事を待つ間の予備か。 */
  z.object({
    ...envelope,
    type: z.literal('optionChosen'),
    arrangementKey: z.string().min(1),
    optionKey: z.string().min(1),
    role: z.enum(['primary', 'backup']),
  }),
  /** 選んだ案（本命・予備）をやめた。頼んだ後なら、取り消しの連絡が要る。 */
  z.object({
    ...envelope,
    type: z.literal('optionDropped'),
    arrangementKey: z.string().min(1),
    optionKey: z.string().min(1),
  }),
  /** 作業を誰かに提案した（仕組みか、もう一人の大人が）。 */
  z.object({
    ...envelope,
    type: z.literal('assignmentProposed'),
    taskKey: z.string().min(1),
    assigneeId: Id,
  }),
  /** 引き受け・断る・済んだ・できなくなった。本人だけ（actorId === assigneeId）。 */
  z.object({
    ...envelope,
    type: z.literal('commitmentChanged'),
    taskKey: z.string().min(1),
    assigneeId: Id,
    action: z.enum(['accept', 'decline', 'done', 'withdraw']),
    /**
     * 引き受けた時に画面で見せた時刻（accept の時だけ）。後で時刻が変われば、引き受けは新しい時刻を
     * 確かめたことにならない（寄り道で遅れる到着も含む）。
     */
    shown: z
      .object({ start: DateTime, end: DateTime, delayedArrival: DateTime.optional() })
      .optional(),
  }),
  /** 外の相手に頼んだ・届けを出した。依頼の一件が始まる（作業は済みになる）。 */
  z.object({
    ...envelope,
    type: z.literal('externalRequestSent'),
    taskKey: z.string().min(1),
    requestId: Id,
  }),
  /** 外の返事（祖母、学童、勤務先）。家族の誰でも記録できる。依頼の一件ごとに記録する。 */
  z.object({
    ...envelope,
    type: z.literal('externalReplyRecorded'),
    requestId: Id,
    reply: z.enum(['yes', 'no']),
  }),
  /** 頼んだ相手に、取り消しの連絡を送った（送るのは家族）。 */
  z.object({
    ...envelope,
    type: z.literal('cancellationSent'),
    requestId: Id,
  }),
  /** 知らせた。同じ知らせを繰り返さず、追いかけた回数を数えるため。 */
  z.object({
    ...envelope,
    type: z.literal('notified'),
    notificationKey: z.string().min(1),
    toMemberId: Id,
  }),
  /** 時計を進めた。試験とデモだけ。 */
  z.object({ ...envelope, type: z.literal('clockAdvanced'), to: DateTime }),
]);
export type DomainEvent = z.infer<typeof DomainEvent>;
export type DomainEventType = DomainEvent['type'];
