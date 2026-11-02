// 計画の結果（要件・手配・案・作業・問い・知らせ）。docs/design/01-model.md §4〜§8。
// 検証器（packages/verify）は、この型・家庭の情報・事象の列を読み、エンジンを読み込まずに確かめる。
// そのため、作業には置いてよい区間・場所・先後・期限・元の手順を写して持たせる。
// 引き受け（家族の誰が受けたか）と、外の相手への依頼（出したか、返事はどうか）は、別の物として持つ。
import { z } from 'zod';
import { DateTime, LocalDate } from '../time';
import { Cost, ExternalKind, Id, PlaceKind, SegmentKind } from './household';

/** 性質（§3）。分からない締切は「好み」にせず、問いにする。 */
export const Nature = z.enum(['required', 'optional', 'preference']);
export type Nature = z.infer<typeof Nature>;

/** 作業の引き受けの状態（§7）。外の相手の返事は、依頼（ExternalRequest）の状態で持つ。 */
export const CommitmentState = z.enum([
  /** 引き受け待ち（仕組みか、もう一人が提案した）。 */
  'proposed',
  /** 本人が受けた。 */
  'accepted',
  /** 本人が済んだと記録した（外に頼む作業なら、頼んだ・出した）。 */
  'done',
  /** 本人が断った。 */
  'declined',
  /** 引き受けた後に、本人ができなくなった。 */
  'withdrawn',
  /** 前提が消えて外した。 */
  'cancelled',
]);
export type CommitmentState = z.infer<typeof CommitmentState>;

export const ENDED_COMMITMENT_STATES: ReadonlySet<CommitmentState> = new Set([
  'done',
  'declined',
  'withdrawn',
  'cancelled',
]);

/** 外の相手への依頼の状態。出した時（externalRequestSent）に始まる。 */
export const ExternalRequestState = z.enum([
  /** 返事待ち。 */
  'awaitingReply',
  /** 「はい」の返事があった（確定）。 */
  'confirmed',
  /** 断られた。 */
  'turnedDown',
  /** 取り消しの連絡を送った。 */
  'cancelled',
]);
export type ExternalRequestState = z.infer<typeof ExternalRequestState>;

/** 画面の状態（§8）。 */
export const PlanStatus = z.enum([
  /** 決めてよい。 */
  'decidable',
  /** 返事しだい。 */
  'dependsOnReply',
  /** 聞いてから。 */
  'askFirst',
  /** このままでは無理。 */
  'infeasible',
  /** まだ判断できない。 */
  'undetermined',
]);
export type PlanStatus = z.infer<typeof PlanStatus>;

/** 根拠（§4）：なぜ要るか。今の事実で成り立たなくなったら、導いた物は生きていない。 */
export const Basis = z.object({
  /** 元の事項（置き換えをたどった今の事項）。 */
  itemIds: z.array(Id),
  requirementKey: z.string().optional(),
  arrangementKey: z.string().optional(),
  optionKey: z.string().optional(),
});
export type Basis = z.infer<typeof Basis>;

export const Requirement = z.object({
  /** 安定したキー：種類と、置き換えをたどった元の事項の ID から作る。時刻や担当は入れない。 */
  key: z.string().min(1),
  kind: z.enum(['childCare', 'belongings', 'attendance', 'submission']),
  /** 品物・行事の名前（原文の言葉）。 */
  what: z.string().min(1),
  date: LocalDate.optional(),
  by: DateTime.optional(),
  nature: Nature,
  basis: Basis,
  live: z.boolean(),
  /**
   * 条件しだい：元の事項の条件が分からないか、効くか分からない作用の先にある。間に合わなくならない側で
   * 残すが、確かな事実や自動で進めてよい物としては見せない（02-foundation §1 の2）。無ければ確か。
   */
  conditional: z.boolean().optional(),
});
export type Requirement = z.infer<typeof Requirement>;

export const OptionPlan = z.object({
  key: z.string().min(1),
  arrangementKey: z.string().min(1),
  templateId: Id,
  titleKey: z.string().min(1),
  /** 決め時（§5）。計算できなければ無く、certainty が undetermined。 */
  decisionDeadline: DateTime.optional(),
  /** checked：計画全体を解いて確かめた。estimate：一つの案の逆算だけ。 */
  deadlineCertainty: z.enum(['checked', 'estimate', 'undetermined']),
  /** 決め時が過ぎて、もう選べない。勧めない。既に選んで動き出した案は、これで無効にしない。 */
  expired: z.boolean(),
  cost: Cost,
  taskKeys: z.array(z.string()),
});
export type OptionPlan = z.infer<typeof OptionPlan>;

/** 外の相手への依頼の一件。出した時に始まり、返事と取り消しで状態が変わる。 */
export const ExternalRequest = z.object({
  requestId: Id,
  /** 依頼を出した作業。 */
  taskKey: z.string().min(1),
  to: Id,
  kind: ExternalKind,
  sentAt: DateTime,
  sentBy: Id,
  state: ExternalRequestState,
  basis: Basis,
  /**
   * 頼んだ時間（送った時の控え）。取り消しの文は、今の手配の日ではなく、これで書く（置き換えで
   * 手配の日が替わっても、相手が覚えているのは頼まれた日）。無いのは古い事象か、時間で頼まない依頼。
   */
  window: z.object({ start: DateTime, end: DateTime }).optional(),
  /** 根拠が今の事実で成り立つか。成り立たず、取り消していなければ、取り消しの連絡が要る。 */
  live: z.boolean(),
  /**
   * 根拠が分からない（読み直しで見つからない、確かでない事項になった）。取り消しの連絡は作らず、
   * 要るかを家族に確かめる（02-foundation §5.6）。この間 live は true のまま（取り消したとは決めない）。
   */
  needsCheck: z.boolean().optional(),
  /**
   * 根拠が今、条件しだい（例：5日に行えば要る）。送った時から分かっていた不確かさで、それだけでは
   * 確かめを求めない。送った後に生じた疑い（送った時は確かだった、置き換え・取り消しが分からない、
   * 読み直しで見つからない）は needsCheck にする。
   */
  conditional: z.boolean().optional(),
});
export type ExternalRequest = z.infer<typeof ExternalRequest>;

/** 手配が「決めてよい」でない理由。検証器は refs をたどって確かめる。 */
export const Reason = z.object({
  code: z.enum([
    /** 返事待ちの依頼がある（refs：requestId）。 */
    'awaitingReply',
    /** 答えで決め方が変わる問いがある（refs：問いの key）。 */
    'askFirst',
    /** 決め時の過ぎていない案が無い（refs：案の key）。 */
    'noOptionLeft',
    /** 探索の手数の上限に達した。 */
    'searchLimit',
    /** 祝日のデータの範囲の外の日がある（refs：日付）。 */
    'holidayDataMissing',
    /** 家庭の情報が足りない（refs：足りない物の名前）。 */
    'inputMissing',
    /** 選んだ案の依頼が断られた（refs：requestId）。予備へ移るか、選び直す。 */
    'turnedDown',
    /** 選んだ案を、決め時を過ぎても始めていない（refs：案の key）。予備へ移るか、選び直す。 */
    'missedDeadline',
  ]),
  refs: z.array(z.string()),
});
export type Reason = z.infer<typeof Reason>;

/** 手配：手当てが要る事（例：12/7 8:10〜18:15 の子の居場所）。 */
export const Arrangement = z.object({
  key: z.string().min(1),
  requirementKey: z.string().min(1),
  kind: z.enum(['childCare', 'purchase']),
  childId: Id.optional(),
  start: DateTime,
  end: DateTime,
  status: PlanStatus,
  recommendedOptionKey: z.string().optional(),
  /** 家族が選んだ本命の案。選ぶのは家族である。 */
  chosenOptionKey: z.string().optional(),
  /** 本命の返事を待つ間に、家族が押さえた予備の案（例：祖母の返事待ちの間の学童の届け）。 */
  backupOptionKeys: z.array(z.string()).default([]),
  /**
   * 選んだ本命・予備のうち、今使う案（本命から順に、断られず決め時も逃していない最初の物）。
   * 無ければ、選んでいないか、選び直しが要る。当日の準備（Task.extra）は、この案の物だけが要る。
   */
  inUseOptionKey: z.string().optional(),
  options: z.array(OptionPlan),
  /** status が decidable でない時の理由。 */
  reasons: z.array(Reason).default([]),
  live: z.boolean(),
  /** 条件しだい（Requirement と同じ）。決めてよくても、条件付きで決めることを画面に出す。 */
  conditional: z.boolean().optional(),
});
export type Arrangement = z.infer<typeof Arrangement>;

/** 作業：誰が・いつ・どこで・何を。 */
export const Task = z.object({
  key: z.string().min(1),
  /** 元の手順（家庭の取れる手の決まり）。検証器が所要・区間・依存を決まりと照らす。 */
  step: z.object({ templateId: Id, stepId: Id }).optional(),
  titleKey: z.string().min(1),
  titleParams: z.record(z.string(), z.string()).default({}),
  basis: Basis,
  durationMin: z.number().int().nonnegative(),
  earliestStart: DateTime.optional(),
  deadline: DateTime.optional(),
  /** 先後と待ち時間（前の作業が終わってから waitMin 分の後に始める）。 */
  after: z
    .array(z.object({ taskKey: z.string().min(1), waitMin: z.number().int().nonnegative() }))
    .default([]),
  /** 置いてよい区間の種類と、場所の決まり。 */
  segments: z.array(SegmentKind).min(1),
  placeId: Id.optional(),
  placeKind: PlaceKind.optional(),
  goods: z.string().optional(),
  /** 外の相手に頼む作業なら、相手と返事の種類。 */
  external: z.object({ to: Id, kind: ExternalKind }).optional(),
  /** 担当（提案を含む）。 */
  assigneeId: Id.optional(),
  /** 置いた時刻と場所。置けていなければ無い。作業そのものの時刻で、移動は含まない。 */
  start: DateTime.optional(),
  end: DateTime.optional(),
  atPlaceId: Id.optional(),
  /** 寄り道の移動（分）。人の時間は [start − before, end + after] を占める。 */
  travelBeforeMin: z.number().int().nonnegative().default(0),
  travelAfterMin: z.number().int().nonnegative().default(0),
  /**
   * 帰り道の寄り道なら、元の到家の時刻（通勤の区間の終わり）と、寄り道で遅れた到家の時刻。
   * 夕方の家の区間は空いた時間で、寄り道で短くなってよい。お迎えと勤務は動かさない（§5）。
   */
  detour: z.object({ plannedArrival: DateTime, delayedArrival: DateTime }).optional(),
  /** 移動の時間の出どころ。estimate は駅からの徒歩の目安（家庭の情報）、maps は地図で確かめた物。 */
  travelSource: z.enum(['none', 'estimate', 'maps']).default('none'),
  commitment: CommitmentState,
  /** 根拠が今の事実で成り立つか。 */
  live: z.boolean(),
  /** 取り消しの連絡の作業なら、取り消す依頼の requestId。 */
  cancels: z.string().optional(),
  /**
   * 引き受けた時の提案の控えと、今の提案が違う（控えの無い古い形も含む）。引き受けは今の中身を
   * 確かめたことにならないので、本人に見せ直す（02-foundation §5.5）。accepted の時だけ付く。
   */
  reconfirm: z.boolean().optional(),
  /**
   * 案を実際に使う時だけ要る当日の準備（家庭の決まりの extraSteps。例：学童の日の弁当）。
   * その案が今使う案（手配の inUseOptionKey）でない間は候補で、引き受けを求めない。
   */
  extra: z.boolean().optional(),
  /**
   * 案の手順の担当が、前後で別の人になっている。紙の受け渡しなどの時間と方法が分からないので、
   * 時刻を置かない（零分で手渡せるとは言わない）。同じ人が続けてするか、家族が受け渡しを決める。
   */
  handoff: z.boolean().optional(),
});
export type Task = z.infer<typeof Task>;

/** 問い（§6）：答えで決め方が変わる時だけ、決め時より前に聞く。 */
export const Question = z.object({
  key: z.string().min(1),
  unknownId: Id,
  toMemberId: Id.optional(),
  askBy: DateTime,
  /** 期限までに答えが無い時に進む側（間に合わなくならない側）。 */
  fallbackValue: z.string().min(1),
  /** 答えで変わる手配・要件の key。 */
  affects: z.array(z.string()),
});
export type Question = z.infer<typeof Question>;

/** 知らせ（§7）：担当の本人だけに。key は冪等のキー。 */
export const Notification = z.object({
  key: z.string().min(1),
  toMemberId: Id,
  at: DateTime,
  kind: z.enum(['decisionApproaching', 'question', 'cancellation', 'assignment']),
  refs: z.array(z.string()),
});
export type Notification = z.infer<typeof Notification>;

/** 前の計画との差分（§4）。安定したキーで比べる。 */
export const Diff = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.string()),
  kept: z.array(z.string()),
});
export type Diff = z.infer<typeof Diff>;

export const PlanResult = z.object({
  householdId: Id,
  now: DateTime,
  /** 計算に使った事象の、最後の通し番号。 */
  throughSeq: z.number().int().nonnegative(),
  requirements: z.array(Requirement),
  arrangements: z.array(Arrangement),
  tasks: z.array(Task),
  requests: z.array(ExternalRequest),
  questions: z.array(Question),
  notifications: z.array(Notification),
  diff: Diff.optional(),
});
export type PlanResult = z.infer<typeof PlanResult>;
