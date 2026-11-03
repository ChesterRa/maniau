// 命令（02-foundation §7.2）。画面がサーバーに送る物。サーバーが権限と前提を確かめて、事象に展開する。
// 画面とサーバーの間の約束なので core に置く（画面はエンジンを読み込まずに使える）。
import { z } from 'zod';
import { DateTime } from '../time';
import { ProposalSnapshot, TaskContent } from './events';
import { Id } from './household';
import { CommitmentState, ExternalRequestState } from './plan';
import { Interpretation } from './source';

/**
 * 画面が見せた時の、事象の通し番号（View の throughSeq）。うちの番かを家族が言う命令（stateTurn）に付ける。
 * その後に、その事項の出典の文・読み取り・事項・答え・うちの番かの言明が替わっていれば（もう一人が直した・
 * 確かめた・外した・言った、読み直した。替わってまた元に戻った時も）、サーバーは断り、画面は今の中身を見せ直す。
 */
export const ItemSeen = z.object({ throughSeq: z.number().int().nonnegative() });
export type ItemSeen = z.infer<typeof ItemSeen>;

/**
 * 画面が見せた作業の担当と状態。二人が同じ札を見る時に、もう一人が先に持った・引き受けた後の古い操作で、
 * それを黙って替えないために付ける（替わっていれば、断って見せ直す）。
 */
export const TaskSeen = z.object({
  taskKey: z.string().min(1),
  assigneeId: Id.nullable(),
  commitment: CommitmentState,
});
export type TaskSeen = z.infer<typeof TaskSeen>;

/** 画面が見せた、外への依頼の状態（返事が来たか等で、案をやめた時の結果が変わる）。 */
export const RequestSeen = z.object({ requestId: Id, state: ExternalRequestState });
export type RequestSeen = z.infer<typeof RequestSeen>;

export const Command = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('answer'),
    unknownId: Id,
    value: z.string().min(1),
    /**
     * 札で見せた品物と、見せた計画の事象の位置（家にあるかの値に答える時は必ず付ける）。今の品物と違うか、
     * 見せた後にその値への答えが入っていれば、断って見せ直す（直された後の古い札で別の品物を「ある」に
     * しない。もう一人の新しい答えを、古い札や候補で上書きしない）。
     */
    seen: z
      .object({ what: z.string().min(1), throughSeq: z.number().int().nonnegative() })
      .optional(),
  }),
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
    /**
     * 決める画面の「選んだら」で見せた物の要約（サーバーが作って渡した物）。付ければ、同じ命令の今の
     * 「選んだら」と違う時に断って見せ直す（見た後に、もう一人が頼んだ・事項の日が直された等で、日・作業・
     * 担当・取り消し・動く作業・重なりが変わっていたら）。
     */
    seen: z.string().min(1).max(128).optional(),
  }),
  z.object({
    type: z.literal('dropOption'),
    arrangementKey: z.string().min(1),
    optionKey: z.string().min(1),
    /**
     * 画面が見せた、その案の生きている作業と外への依頼の全部（付ければ、どれかが替わっていた時に断る。
     * 返事が来た後にやめると、取り消しの連絡が要る等、結果が変わる）。
     */
    seen: z.object({ tasks: z.array(TaskSeen), requests: z.array(RequestSeen) }).optional(),
  }),
  z.object({
    type: z.literal('proposeAssignment'),
    taskKey: z.string().min(1),
    assigneeId: Id,
    /** 画面が見せた、その作業の担当と状態（付ければ、替わっていた時に断る）。 */
    seen: TaskSeen.optional(),
  }),
  /** 引き受ける。本人が見た提案の控えを付ける。今の提案と違えば断って見せ直す。 */
  z.object({ type: z.literal('accept'), taskKey: z.string().min(1), shown: ProposalSnapshot }),
  z.object({
    type: z.literal('commitment'),
    taskKey: z.string().min(1),
    action: z.enum(['decline', 'done', 'withdraw']),
    /** 札で見せた用件（済んだと記録する時は必ず付ける）。今の用件と違えば断って見せ直す。 */
    seen: TaskContent.optional(),
  }),
  /**
   * 外の相手に頼んだと記録する。控えはサーバーが今の計画から作る。頼む時間のある依頼（子の居場所）は、画面で
   * 見せた頼む時間（window）を必ず付ける。今の控えと違えば断って見せ直す（日が直された後の古い画面から、
   * 新しい日を送ったことにしない）。
   */
  z.object({
    type: z.literal('recordSent'),
    taskKey: z.string().min(1),
    requestId: Id,
    window: z.object({ start: DateTime, end: DateTime }).optional(),
  }),
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
  /**
   * 当番が、うちの番か（「うちの番です」「うちの番ではない」）。読んだ中身の確かめ・取り下げとは別の言明で、
   * 事項の確かさも作用（ほかのお知らせの置き換え・取り消し）も変えない。サーバーが今の用件と対象を控える。
   */
  z.object({ type: z.literal('stateTurn'), itemId: Id, ours: z.boolean(), seen: ItemSeen }),
  /**
   * 習い事・クラブの行事の送り・迎えが、今回要るか（「今回は要らない」）。家の決まりとは別の、今回の言明。
   * 事項の確かさも作用も変えない。サーバーが今の子・用件・日・書かれた時刻・場所を控える。seen は見せた
   * 計画の通し番号で、その後に何か入っていれば断る（ほかの出典の取り消しと、その取り下げも含む）。
   */
  /**
   * 引き受けた作業が「もう要りません」「まだ要るか確かめて」と出た札で、本人が分かったと言う（引き受けを
   * 取り下げる）。seen は見せた計画の通し番号で、今と違えば断る（その間に作業が戻った・別の札になった時に、
   * 戻った引き受けを取り下げない）。
   */
  z.object({ type: z.literal('acknowledgeReleased'), taskKey: z.string().min(1), seen: ItemSeen }),
  z.object({
    type: z.literal('stateEscort'),
    itemId: Id,
    leg: z.enum(['to', 'from']),
    needed: z.boolean(),
    seen: ItemSeen,
  }),
  z.object({ type: z.literal('withdrawSource'), sourceId: Id }),
  /** 時計を進める。デモの家庭だけ。 */
  z.object({ type: z.literal('advanceClock'), to: DateTime }),
]);
export type Command = z.infer<typeof Command>;
