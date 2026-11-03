// 事象（状態の正本）。追記だけの列で、今の状態はいつでも事象から作り直せる（docs/design/01-model.md §2）。
import { z } from 'zod';
import { DateTime, toEpochMinutes } from '../time';
import { ExternalKind, Household, Id } from './household';
import { Basis, type Task, untimed } from './plan';
import { Interpretation, Item, Sentence, Source } from './source';

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

/**
 * 依頼を送った時の控え（02-foundation §5.6）。送った時に計画で見えていた物を写す（requestSnapshot で作る）。
 * 後で今の計画と比べ、送った後に条件や時間が替わったら、要るかを頼んだ本人に確かめる。
 */
export const RequestSnapshot = z.object({
  to: Id,
  kind: ExternalKind,
  basis: Basis,
  /** 送った時、根拠が条件しだいだったか（頼んだ文がもともと条件付き）。後から生じた疑いと分ける。 */
  conditional: z.boolean().optional(),
  /**
   * 送った時の根拠の条件の形（conditionShape。節点の ID を除いた式。条件が無ければ NO_CONDITION）。
   * 無いのは古い事象で、その時は条件が替わったかを決めない。
   */
  condition: z.string().min(1).optional(),
  /** 頼んだ時間（子の居場所の手配の区間、窓の「すること」の窓）。無いのは古い事象か、時間で頼まない依頼。 */
  window: z.object({ start: DateTime, end: DateTime }).optional(),
  /**
   * 通用の「すること」の依頼だけ：頼んだ時の「すること」の中身と、やり方の版の要約（needWaysBasis）。今と違えば、
   * 要るかを頼んだ本人に確かめてもらう（日・締切・だれのため・やり方が替わった時に、前の返事を当てない）。
   */
  about: z.string().min(1).optional(),
  /** 子の居場所の依頼だけ：頼んだ時の手配の子（成員の ID）。無いのは古い事象か、子の居場所でない依頼。 */
  childId: Id.optional(),
});
export type RequestSnapshot = z.infer<typeof RequestSnapshot>;

/**
 * 引き受けた時に本人が見た提案の控え（02-foundation §5.5）。命令は accept に必ず付ける。控えの無い
 * accept は古い形で、今の作業を確かめたことにはしない。今の提案と違えば、確かめ直しが要る。
 */
export const ProposalSnapshot = z.object({
  /** 置いた時刻。無いのは、時刻なしで引き受ける作業（書かれた時刻の無い当番など。Task.timing）だけ。 */
  start: DateTime.optional(),
  end: DateTime.optional(),
  /** 寄り道で遅れる到家の時刻（帰り道の寄り道の時だけ）。 */
  delayedArrival: DateTime.optional(),
  /** 用件（画面の文言のキーと値）。 */
  titleKey: z.string().min(1),
  titleParams: z.record(z.string(), z.string()),
  /** 場所（店など）。無ければ場所を問わない作業。 */
  atPlaceId: Id.optional(),
  travelBeforeMin: z.number().int().nonnegative(),
  travelAfterMin: z.number().int().nonnegative(),
  /** 外の相手に頼む作業なら、相手と返事の種類。 */
  external: z.object({ to: Id, kind: ExternalKind }).optional(),
  /**
   * 見せた時の根拠の条件（作業の condition：式の形・未定の値の名前・確かでないか）。画面は条件を添えて
   * 見せるので、条件も見た物に入る。
   * 無いのは条件の無い作業か、古い控え（条件の有る今の作業とは違う物として扱う）。
   */
  condition: z.string().min(1).optional(),
  /** 通用の「すること」の作業だけ：見せた時の中身とやり方の版の要約（Task.about）。 */
  about: z.string().min(1).optional(),
});
export type ProposalSnapshot = z.infer<typeof ProposalSnapshot>;

/** 二つの提案の控えが同じ中身か（時刻は同じ瞬間なら同じ。用件の値は並びによらない）。 */
export function sameProposal(a: ProposalSnapshot, b: ProposalSnapshot): boolean {
  const key = (p: ProposalSnapshot) =>
    JSON.stringify([
      p.start === undefined ? null : toEpochMinutes(p.start),
      p.end === undefined ? null : toEpochMinutes(p.end),
      p.delayedArrival === undefined ? null : toEpochMinutes(p.delayedArrival),
      p.titleKey,
      Object.entries(p.titleParams).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
      p.atPlaceId ?? null,
      p.travelBeforeMin,
      p.travelAfterMin,
      p.external ? [p.external.to, p.external.kind] : null,
      p.condition ?? null,
      p.about ?? null,
    ]);
  return key(a) === key(b);
}

/**
 * 作業の用件（画面の文言のキーと値）。済んだと記録する時に、札で見せた用件を控える。読み直し・直し・
 * 置き換えで作業のキーは同じまま用件だけが替わる（白い長袖シャツが赤い帽子になる）ので、前の物を
 * 済ませた記録を、別の物に当てないために使う。
 */
export const TaskContent = z.object({
  titleKey: z.string().min(1),
  titleParams: z.record(z.string(), z.string()),
  /** 通用の「すること」の作業だけ：済ませた時の中身とやり方の版の要約（Task.about）。 */
  about: z.string().min(1).optional(),
});
export type TaskContent = z.infer<typeof TaskContent>;

/** 作業の今の用件（済んだと記録する時に、札で見せた物として付ける）。 */
export function taskContent(task: Task): TaskContent {
  return {
    titleKey: task.titleKey,
    titleParams: task.titleParams,
    ...(task.about === undefined ? {} : { about: task.about }),
  };
}

/** 二つの用件が同じか（用件の値は並びによらない）。 */
export function sameContent(a: TaskContent, b: TaskContent): boolean {
  const key = (c: TaskContent) =>
    JSON.stringify([
      c.titleKey,
      Object.entries(c.titleParams).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
      c.about ?? null,
    ]);
  return key(a) === key(b);
}

/**
 * 引き受けの時に見せる提案の控え（02-foundation §5.5）。置けていない作業（時刻が無い）には作れない。
 * ただし、時刻なしで引き受ける作業（Task.timing の day・undated）は、時刻の無い控えにする。
 * 画面はこの控えを見せ、引き受けの命令はこれを付ける。
 */
export function proposalSnapshot(task: Task): ProposalSnapshot | undefined {
  // 時刻に置けていない作業は引き受けられない（置けない理由を見せる）。書かれた時刻の無い当番などは、
  // 時刻なしで引き受ける（仕組みが時刻を作らない）。
  if (!untimed(task) && (task.start === undefined || task.end === undefined)) return undefined;
  return {
    ...(task.start === undefined ? {} : { start: task.start }),
    ...(task.end === undefined ? {} : { end: task.end }),
    ...(task.detour ? { delayedArrival: task.detour.delayedArrival } : {}),
    titleKey: task.titleKey,
    titleParams: task.titleParams,
    ...(task.atPlaceId === undefined ? {} : { atPlaceId: task.atPlaceId }),
    travelBeforeMin: task.travelBeforeMin,
    travelAfterMin: task.travelAfterMin,
    ...(task.external ? { external: task.external } : {}),
    ...(task.condition === undefined ? {} : { condition: task.condition }),
    ...(task.about === undefined ? {} : { about: task.about }),
  };
}

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
    /**
     * 読んだ出典の文の版（書き起こしを直すと上がる）。読み取りは非同期で、直す前に始めた読み取りが
     * 後で終わることがあるので、記録した順ではなく、この版で古い読み取りを見分ける。無いのは古い形。
     */
    sourceVersion: z.number().int().positive().optional(),
    /** 呼び出しの種類ごとの型で、使う時に検査する。 */
    output: z.unknown(),
  }),
  /** 問いに答えた（未定の値が決まった）。 */
  z.object({
    ...envelope,
    type: z.literal('answered'),
    unknownId: Id,
    value: z.string().min(1),
    /**
     * 家にあるかの値に答えた時、札で見せた品物。品物が直されて別の物になれば、この答えは使わない
     * （まだ分からないものとして扱う）。家族が決める値に答えた時は、答えた時の問いの形（名前・値・その値を
     * 使う事項の中身と条件の式。サーバーが familyQuestionBasis で付ける）。読み直しや直しで替われば使わない（聞き直す）。
     * 無いのは古い事象か、品物を見せずに答えた物。
     */
    about: z.string().min(1).optional(),
  }),
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
    /** 引き受けた時に見た提案の控え（accept の時だけ）。 */
    shown: ProposalSnapshot.optional(),
    /**
     * 引き受けた時の作業の根拠の事項と、そのお知らせ（事項・出典の ID。accept の時だけ）。後で作業が計画から
     * 無くなった時に、はっきり要らなくなったのか（取り消し・関係ない・取り下げ・家族の決まりの変更）、根拠を
     * 消した・読み直しで見つからない等で分からないのかを分ける。無いのは古い事象。
     */
    basisItemIds: z.array(Id).optional(),
    basisSourceIds: z.array(Id).optional(),
    /**
     * 済んだと記録した時に見せた用件（done の時だけ）。今の作業の用件と違えば、この済みは今の作業に
     * 当てない（直されて別の物になった）。無いのは古い事象。
     */
    content: TaskContent.optional(),
  }),
  /** 外の相手に頼んだ・届けを出した。依頼の一件が始まる（作業は済みになる）。 */
  z.object({
    ...envelope,
    type: z.literal('externalRequestSent'),
    taskKey: z.string().min(1),
    requestId: Id,
    /**
     * 送った時の控え。依頼は、後の作業の一覧から逆算せず、この控えから作る（02-foundation §5.6）。
     * 控えの無い古い事象だけ、今の作業から補う。
     */
    snapshot: RequestSnapshot.optional(),
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
  /**
   * 知らせを、送り出しの事業者が受け付けた（仕組み＝system だけが書く。02-foundation §5.7）。
   * 本人に届いた・読んだ証拠ではない。失敗・結果不明は運用の表に残し、この事象にしない。
   */
  z.object({
    ...envelope,
    type: z.literal('notified'),
    notificationKey: z.string().min(1),
    toMemberId: Id,
    channel: z.enum(['webPush']),
    result: z.literal('accepted'),
    kind: z.enum(['decisionApproaching', 'question', 'cancellation', 'assignment']),
    /** 送った中身の控え（文言のキーと値）。 */
    content: z.object({ titleKey: z.string().min(1), params: z.record(z.string(), z.string()) }),
    appVersion: z.string().min(1),
  }),
  /** 家族が、推定・食い違いの事項を確かめた（「家族が確認」。要件と作用が効く。§5.2）。 */
  z.object({ ...envelope, type: z.literal('itemConfirmed'), itemId: Id }),
  /**
   * 家族が書いた出典（noticeReceived の sender family。文は家族の一言の原文）の事項。家族の言明で、モデルの
   * 読み取りではない。家族が画面で確かめた欄だけを持ち、evidence は stated。取り下げ・直し・消去は、ほかの
   * 出典と同じ命令で行う。
   */
  z.object({
    ...envelope,
    type: z.literal('itemsStated'),
    sourceId: Id,
    items: z.array(Item).min(1),
  }),
  /**
   * 家族が、「すること」（need）に使うやり方を選んだ（家族の意向。外の相手の同意や、済んだことではない）。
   * about は、選んだ時の「すること」の中身と、やり方の版の要約。どちらかが変われば、この選びを当てない。
   * 同じ事項への後の選びが、前の選びに代わる。
   */
  z.object({
    ...envelope,
    type: z.literal('needWaysSet'),
    itemId: Id,
    wayIds: z.array(Id),
    about: z.string().min(1),
  }),
  /**
   * 家族が、事項の解釈の一部を直した。直した欄だけを持ち、解釈を置き換えて「家族が確認」にする。
   * 事項の ID は変わらない。原文は変えない（書かれた事と、家族の解釈を分けて残す）。
   */
  z.object({
    ...envelope,
    type: z.literal('itemCorrected'),
    itemId: Id,
    interpretation: Interpretation.refine((value) => Object.keys(value).length > 0, {
      message: '直す欄が無い',
    }),
  }),
  /** 家族が「関係ない」とした（うちの子に関係ない、読み違い）。要件も作用も起こさない。itemConfirmed で戻せる。 */
  z.object({
    ...envelope,
    type: z.literal('itemDismissed'),
    itemId: Id,
    reason: z.enum(['notOurs', 'misread', 'other']),
  }),
  /**
   * 家族が、当番がうちの番か（ours）を言った。言った時の用件と対象（今の解釈）を控え、後で用件か対象が直され
   * たら、もう当てない。読んだ中身の確かめ・取り下げとは別の事実で、事項の確かさも作用も変えない（「うちの番
   * ではない」で、ほかのお知らせへの置き換えを戻さない。「うちの番です」で、推定の日を確かな物にしない）。
   * 同じ事項への後の言明が、前の言明に代わる。
   */
  z.object({
    ...envelope,
    type: z.literal('turnStated'),
    itemId: Id,
    ours: z.boolean(),
    what: z.string(),
    audience: z.string().nullable(),
  }),
  /**
   * 家族が、習い事・クラブの行事の送り（to）か迎え（from）が、今回要るか（needed）を言った。家の決まり
   * （子の clubEscort）より、今回の言明を先に使う。言った時の子・用件・日・書かれた時刻・場所を控え、どれかが
   * 変われば（決まりのある子が替わった、場所が直された）もう当てない。事項の確かさも作用も変えない（要らない
   * と言っても、行事の置き換え・取り消しを戻さない）。
   */
  z.object({
    ...envelope,
    type: z.literal('escortStated'),
    itemId: Id,
    leg: z.enum(['to', 'from']),
    needed: z.boolean(),
    childId: Id,
    what: z.string(),
    /** その方の日（迎えは、終わりが次の日と読めれば次の日）。 */
    date: z.string(),
    /** 書かれた時刻。時刻の無い方（その日の作業）は null。 */
    at: z.string().nullable(),
    place: z.string().nullable(),
  }),
  /**
   * 家族が「このお知らせはもう当てはまらない」と言った（取り下げ）。事項は全て生きていない扱いになり、
   * 頼んだ後なら取り消しの連絡が要る。削除（sourceContentPurged）とは分ける（§5.1）。
   */
  z.object({ ...envelope, type: z.literal('sourceWithdrawn'), sourceId: Id }),
  /**
   * 削除の仕事が、出典の中身を消した（仕組み＝system が書く）。photo は写真だけで、計画は変わらない。
   * all はお知らせごとで、事項・答え・作用を使わない。行事が中止になったとは推し量らず、それに頼る
   * 依頼と引き受けは要確認にする（§5.1・§6.4）。
   */
  z.object({
    ...envelope,
    type: z.literal('sourceContentPurged'),
    sourceId: Id,
    scope: z.enum(['photo', 'all']),
  }),
  /**
   * 家族が、写真の書き起こしを直した。文を置き換え、版を上げる。読み直しが続く（§4.1）。読み直しが
   * 終わるまで、前の版から読んだ事項は確かとしない（条件しだい）。
   */
  z.object({
    ...envelope,
    type: z.literal('transcriptionCorrected'),
    sourceId: Id,
    /** 直した後の文の版（出典の版。事象の形の版 version とは別）。 */
    sourceVersion: z.number().int().positive(),
    sentences: z.array(Sentence).min(1),
  }),
  /**
   * 「送った」の押し間違い（実際には何も送っていない）。送ったと記録した本人だけが、返事も取り消しも
   * まだ無い間に使える。元の事象は消さず、依頼を無かった事にする。取り消しを送ったことにはならない（§5.6）。
   */
  z.object({ ...envelope, type: z.literal('requestRecordCorrected'), requestId: Id }),
  /** 時計を進めた。試験とデモだけ。 */
  z.object({ ...envelope, type: z.literal('clockAdvanced'), to: DateTime }),
]);
export type DomainEvent = z.infer<typeof DomainEvent>;
export type DomainEventType = DomainEvent['type'];
