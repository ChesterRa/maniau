// 命令（02-foundation §7.2）。画面がサーバーに送る物。サーバーが権限と前提を確かめて、事象に展開する。
// 画面とサーバーの間の約束なので core に置く（画面はエンジンを読み込まずに使える）。
import { z } from 'zod';
import { DateTime } from '../time';
import { ProposalSnapshot } from './events';
import { Id } from './household';
import { Interpretation } from './source';

export const Command = z.discriminatedUnion('type', [
  z.object({ type: z.literal('answer'), unknownId: Id, value: z.string().min(1) }),
  /**
   * 案を選ぶ（本命・予備）。担当を付ければ、その案の作業（当日の準備を除く）を提案する。自分が担当なら、
   * 画面で見せた提案の控えを作業ごとに付けた物だけを引き受ける（今の提案と違えば断る。§5.5・§7.2）。
   */
  z.object({
    type: z.literal('chooseOption'),
    arrangementKey: z.string().min(1),
    optionKey: z.string().min(1),
    role: z.enum(['primary', 'backup']),
    assigneeId: Id.optional(),
    shown: z.array(z.object({ taskKey: z.string().min(1), snapshot: ProposalSnapshot })).optional(),
  }),
  z.object({
    type: z.literal('dropOption'),
    arrangementKey: z.string().min(1),
    optionKey: z.string().min(1),
  }),
  z.object({ type: z.literal('proposeAssignment'), taskKey: z.string().min(1), assigneeId: Id }),
  /** 引き受ける。本人が見た提案の控えを付ける。今の提案と違えば断って見せ直す。 */
  z.object({ type: z.literal('accept'), taskKey: z.string().min(1), shown: ProposalSnapshot }),
  z.object({
    type: z.literal('commitment'),
    taskKey: z.string().min(1),
    action: z.enum(['decline', 'done', 'withdraw']),
  }),
  /** 外の相手に頼んだと記録する。控えはサーバーが今の計画から作る。 */
  z.object({ type: z.literal('recordSent'), taskKey: z.string().min(1), requestId: Id }),
  z.object({ type: z.literal('correctSentRecord'), requestId: Id }),
  z.object({ type: z.literal('recordReply'), requestId: Id, reply: z.enum(['yes', 'no']) }),
  z.object({ type: z.literal('recordCancellationSent'), requestId: Id }),
  z.object({ type: z.literal('confirmItem'), itemId: Id }),
  z.object({ type: z.literal('correctItem'), itemId: Id, interpretation: Interpretation }),
  z.object({
    type: z.literal('dismissItem'),
    itemId: Id,
    reason: z.enum(['notOurs', 'misread', 'other']),
  }),
  z.object({ type: z.literal('withdrawSource'), sourceId: Id }),
  /** 時計を進める。デモの家庭だけ。 */
  z.object({ type: z.literal('advanceClock'), to: DateTime }),
]);
export type Command = z.infer<typeof Command>;
