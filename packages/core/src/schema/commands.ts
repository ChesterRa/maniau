// 命令（02-foundation §7.2）。画面がサーバーに送る物。サーバーが権限と前提を確かめて、事象に展開する。
// 画面とサーバーの間の約束なので core に置く（画面はエンジンを読み込まずに使える）。
import { z } from 'zod';
import { DateTime, LocalDate, LocalTime } from '../time';
import { ProposalSnapshot, TaskContent } from './events';
import { Household, Id } from './household';
import { CommitmentState, ExternalRequestState } from './plan';
import { CorrectedInterpretation, Interpretation } from './source';

/**
 * 画面が見せた時の、事象の通し番号（View の throughSeq）。うちの番かを家族が言う命令（stateTurn）に付ける。
 * その後に、その事項の出典の文・読み取り・事項・答え・うちの番かの言明が替わっていれば（もう一人が直した・
 * 確かめた・外した・言った、読み直した。替わってまた元に戻った時も）、サーバーは断り、画面は今の中身を見せ直す。
 * changes は、保存の前に見せた「この変更で変わること」の要約（サーバーが作る）。計画に入っている「すること」を
 * 直す・外す時は要る（下の correctItem・dismissItem）。
 */
export const ItemSeen = z.object({
  throughSeq: z.number().int().nonnegative(),
  changes: z.string().min(1).optional(),
});
export type ItemSeen = z.infer<typeof ItemSeen>;

/**
 * 家族の言明の「すること」の欄。何を（what）と形（shape）は要る。by は締切（deadline）、window は日と始まり・
 * 終わり（同じ日の中）が要る（無い・日をまたぐ時は、サーバーが断る。時刻を作らない）。
 */
export const NeedInterpretation = Interpretation.pick({
  date: true,
  startTime: true,
  endTime: true,
  deadline: true,
  deadlineDayOnly: true,
  place: true,
  audience: true,
  forMemberId: true,
  holdNeeded: true,
}).extend({
  what: z.string().trim().min(1).max(200),
  shape: z.enum(['by', 'window']),
});
export type NeedInterpretation = z.infer<typeof NeedInterpretation>;

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

/**
 * 家と暮らしの情報（家族・ふだんの一週間・場所・取れる手）を直す。画面は直した家の情報を丸ごと送る。直せる範囲は
 * サーバーが決める（成員の ID・種類・有効と、場所・取れる手の ID は替えない。02-foundation §6）。
 */
const UpdateHousehold = z.object({ type: z.literal('updateHousehold'), household: Household });
/**
 * 家族の言明で「すること」を足す（02-foundation §3.4）。text は家族の一言の原文、interpretation は家族が画面で
 * 確かめた欄（何を・形・日・時刻・締切・場所・だれのため）。サーバーが、家族の出典と、その出典の事項（need。
 * evidence stated）に展開する。
 */
/**
 * いつにするかの候補の時（同じ日の中の始まり–終わり）。id は、前からある候補を直す時だけ付ける（サーバーが付けた
 * もの）。新しい候補には付けない（サーバーが付ける）。
 */
export const CandidateTime = z.object({
  id: Id.optional(),
  date: LocalDate,
  startTime: LocalTime,
  endTime: LocalTime,
});
export type CandidateTime = z.infer<typeof CandidateTime>;

const StateNeed = z.object({
  type: z.literal('stateNeed'),
  text: z.string().trim().min(1).max(500),
  interpretation: NeedInterpretation,
  /**
   * 窓の「すること」で、いつにするかを相手の答えで決める時の候補（2〜8）。あれば、日・始まり・終わりは要らない
   * （候補が持つ）。サーバーが候補の ID と代（rev）を付ける。
   */
  candidates: z.array(CandidateTime).min(2).max(8).optional(),
});
/**
 * 一言の「すること」を一度に足す（02-foundation §3.4 の言明と、§6 のやり方・本命・担当を一つの命令で）。家族の一言
 * （原文。そのまま「何を」にする）・いつまでに（日。時刻は任意で、無ければその日のうち）・だれが済ませるか（家の大人）を
 * 入れると、締切の形の「すること」に、家族が自分たちで済ませる一つのやり方（家に無ければ、その名前で足す）を選び、
 * 本命にして、その人に作業を提案する。書く事象は、家の情報・言明・やり方の選び・本命の選び・担当の提案と同じ種類
 * （新しい種類は無い）。足したやり方は、ほかのやり方と同じく、家族が直せる・やめられる。
 */
/** 一言の「すること」で使う、自分たちで済ませるやり方の ID（家に一つ。家族が直せる・やめられる）。 */
export const SELF_WAY_ID = 'way-self';
const AddThing = z.object({
  type: z.literal('addThing'),
  text: z.string().trim().min(1).max(500),
  date: LocalDate,
  byTime: LocalTime.optional(),
  assigneeId: Id,
  /** 家に自分たちで済ませるやり方が無い時に足す、やり方と手順の名前（画面の言葉）。 */
  wayName: z.string().trim().min(1).max(40),
  stepName: z.string().trim().min(1).max(40),
});
/**
 * 窓の「すること」の候補を置き直す（全部を送る）。前からある候補は id を付ける。時刻が変われば、サーバーがその
 * 候補の代（rev）を進め、前の代への答えは当てない。消した候補の id は使い回さない。
 */
const SetNeedCandidates = z.object({
  type: z.literal('setNeedCandidates'),
  itemId: Id,
  candidates: z.array(CandidateTime).min(2).max(8),
});
/** 候補の一つに決める（その候補の今の代）。決めると、その時が「すること」の窓になる。 */
const ChooseCandidate = z.object({
  type: z.literal('chooseCandidate'),
  itemId: Id,
  candidateId: Id,
  rev: z.number().int().positive(),
});
/**
 * 「すること」に使うやり方を選ぶ（家族の選択。空にすれば、選んでいない状態に戻す）。サーバーは、選んだ時の
 * 「すること」の中身とやり方の版を控える。
 */
const SetNeedWays = z.object({ type: z.literal('setNeedWays'), itemId: Id, wayIds: z.array(Id) });
/**
 * 読み取りの事項（「すること」も）を直す・外す。計画に入っている「すること」（家族の言明か、家族が確かめた読み取り）は、
 * 保存の前に「この変更で変わること」を見せ、見た物（seen の changes）と今が同じ時だけ書く（引き受けを要らなくし、
 * 送った依頼に取り消しの連絡を要るようにするので）。まだ確かめていない読み取りは、見せた番号だけ。
 */
const CorrectItem = z.object({
  type: z.literal('correctItem'),
  itemId: Id,
  /** 直す欄だけ。「だれのため」を外すのは null（直しは前の欄に重ねるので）。 */
  interpretation: CorrectedInterpretation,
});
const DismissItem = z.object({
  type: z.literal('dismissItem'),
  itemId: Id,
  reason: z.enum(['notOurs', 'misread', 'other']),
});
/** 入れ間違えた通知、または誤った読み取りを計画から外す。現実の取り消しとは別。 */
const DiscardSource = z.object({
  type: z.literal('discardSource'),
  sourceId: Id,
  reason: z.enum(['misfiled', 'misread']),
});
/**
 * 保存の前に見せた物：計画の通し番号と、見せた「この変更で変わること」の要約（サーバーが作る）。書く時は要る。
 * 今と違えば断って見せ直す（もう一人の変更・時が進んで変わった結果を、黙って書かない）。
 */
const Seen = z.object({ throughSeq: z.number().int().nonnegative(), changes: z.string().min(1) });

/** 頼んだ相手の返事を記録する（家族の誰でも。依頼の一件ごと。返事が変わった時も同じ命令）。 */
const RecordReply = z.object({
  type: z.literal('recordReply'),
  requestId: Id,
  reply: z.enum(['yes', 'no']),
});

/**
 * 保存の前に「この変更で変わること」を見る命令（seen の無い中身。見るだけで、何も書かない）。recordReply は
 * 「断られたら？」（返事の仮定）：まだ来ていない返事を仮に置いて計算するだけで、画面はこれを保存しない（本当の
 * 返事は、今までどおり命令で記録する）。
 */
export const PreviewCommand = z.discriminatedUnion('type', [
  UpdateHousehold,
  StateNeed,
  AddThing,
  SetNeedWays,
  SetNeedCandidates,
  ChooseCandidate,
  CorrectItem,
  DismissItem,
  DiscardSource,
  RecordReply,
]);
export type PreviewCommand = z.infer<typeof PreviewCommand>;
/** 見てから保存する命令（返事の仮定を除く。保存の時に、見た物 seen を付けて送る）。 */
export type SaveablePreview = Exclude<PreviewCommand, { type: 'recordReply' }>;

export const Command = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('answer'),
    unknownId: Id,
    value: z.string().min(1),
    /**
     * 札で見せた品物と、見せた計画の事象の位置（家にあるかの値と、家族が決める値に答える時は必ず付ける）。
     * 家にあるかは、今の品物と違うか、見せた後にその値への答えが入っていれば、断って見せ直す（直された後の
     * 古い札で別の品物を「ある」にしない。もう一人の新しい答えを、古い札や候補で上書きしない）。家族が決める
     * 値は、見せた計画の通し番号が今と同じ時だけ受ける（問いの中身・ほかの人の答え・読み直しが替われば断る）。
     * 問いの札から答える時は、見せた問い（key・until・affects）も付け、今の時刻で作った問いと同じ時だけ受ける
     * （事象が無くても、期限が過ぎて消えた・変わった問いの古い札では答えない）。一言などの札でない答えには
     * 付けない（家族が言った決めごとは、問いが消えた後も記録する）。
     */
    seen: z
      .object({
        what: z.string().min(1).optional(),
        throughSeq: z.number().int().nonnegative(),
        question: z
          .object({
            key: z.string().min(1),
            until: DateTime.optional(),
            affects: z.array(z.string()),
          })
          .optional(),
      })
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
    /** 見せた計画と時刻。作業が消えた後も、送った事実を当時の控えで記録するため。 */
    shown: z.object({ throughSeq: z.number().int().nonnegative(), at: DateTime }).optional(),
  }),
  z.object({ type: z.literal('correctSentRecord'), requestId: Id }),
  RecordReply,
  z.object({ type: z.literal('recordCancellationSent'), requestId: Id }),
  /**
   * 読み取りの事項を確かめる・直す・外す。モデルが読んだ「すること」は、見せた時の番号（seen）が要る：見せた後に
   * 出典の文・事項・答え・言明・読み直しがあれば、古い画面から決めさせない。
   */
  z.object({ type: z.literal('confirmItem'), itemId: Id, seen: ItemSeen.optional() }),
  CorrectItem.extend({ seen: ItemSeen.optional() }),
  DismissItem.extend({ seen: ItemSeen.optional() }),
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
  /** 根拠が分からなくなった依頼を、送った本人が控えを見て、要るまま残すか、要らないと決める。 */
  z.object({
    type: z.literal('resolveRequestCheck'),
    requestId: Id,
    decision: z.enum(['keep', 'cancel']),
    seen: z.object({ throughSeq: z.number().int().nonnegative() }),
  }),
  DiscardSource.extend({ seen: Seen.optional() }),
  UpdateHousehold.extend({ seen: Seen.optional() }),
  StateNeed.extend({ seen: Seen.optional() }),
  AddThing.extend({ seen: Seen.optional() }),
  SetNeedWays.extend({ seen: Seen.optional() }),
  SetNeedCandidates.extend({ seen: Seen.optional() }),
  ChooseCandidate.extend({ seen: Seen.optional() }),
  /**
   * 「すること」をだれと調整するか。members は家の大人と頼める人（家庭の成員の ID）、guests はその用件の中の相手
   * （名前だけ。家庭の成員にしない。id は前からいる相手だけ付ける）。required は要る人、minCount は最少の人数。
   * 名簿から外した人のリンクは、サーバーが止める。
   */
  z.object({
    type: z.literal('setNeedPeople'),
    itemId: Id,
    members: z.array(Id).max(30),
    guests: z
      .array(z.object({ id: Id.optional(), name: z.string().trim().min(1).max(40) }))
      .max(30),
    required: z.array(Id).max(30),
    minCount: z.number().int().min(0).max(60),
  }),
  /**
   * 候補への答えを記録する。personId が自分なら自分の答え（self）、ほかの人なら家族の記録（family）。withdrawn は、
   * その出所の答えを取り下げる（未回答に戻す。「いいえ」ではない）。note は「たぶん」の条件や一言。
   */
  z.object({
    type: z.literal('recordAvailability'),
    itemId: Id,
    candidateId: Id,
    rev: z.number().int().positive(),
    personId: Id,
    answer: z.enum(['yes', 'maybe', 'no', 'withdrawn']),
    note: z.string().trim().min(1).max(140).optional(),
  }),
  /**
   * 相手一人の、答えるリンクを出す（出し直すと、前のリンクは効かない）。鍵は応答で一度だけ返す。デモの家庭だけ。
   */
  z.object({ type: z.literal('issueAnswerLink'), itemId: Id, personId: Id }),
  /** 相手一人の、今のリンクを止める。 */
  z.object({ type: z.literal('revokeAnswerLink'), itemId: Id, personId: Id }),
  /** 時計を進める。デモの家庭だけ。 */
  z.object({ type: z.literal('advanceClock'), to: DateTime }),
]);
export type Command = z.infer<typeof Command>;
