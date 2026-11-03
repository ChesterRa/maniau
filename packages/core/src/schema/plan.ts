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
  kind: z.enum(['childCare', 'belongings', 'attendance', 'submission', 'escort', 'need']),
  /** 品物・行事の名前（原文の言葉）。 */
  what: z.string().min(1),
  /** 子の居場所なら、その日。持ち物なら、書かれた使う日（持って行く日。書かれていなければ無し）。 */
  date: LocalDate.optional(),
  /** 持ち物なら、用意の締切（書かれた締切か、使う日の朝 8:00）。 */
  by: DateTime.optional(),
  nature: Nature,
  basis: Basis,
  live: z.boolean(),
  /**
   * 条件しだい：元の事項の条件が分からないか、効くか分からない作用の先にある。間に合わなくならない側で
   * 残すが、確かな事実や自動で進めてよい物としては見せない（02-foundation §1 の2）。無ければ確か。
   */
  conditional: z.boolean().optional(),
  /**
   * 持ち物なら、家にあるかの値（仕組みが作る）。家にあると答えて買い物の手配が無い時も、用意の締切までは
   * 答え直せるように（「やっぱり無かった」）、要件が持つ。
   */
  atHomeUnknownId: Id.optional(),
  /**
   * 持ち物なら、家族の今の答え（家にあるか）。答えた時の品物が今の品物と違えば、その答えは使わない（無い）。
   * 使う日の前の日と使う日の「持って行く物」と、「やっぱり無かった」を出すのに使う。
   */
  atHome: z.enum(['yes', 'no']).optional(),
  /**
   * 持ち物なら、買い終えたと記録してあるか（済んだ時の品物が今の品物と同じ時だけ）。用意の締切を過ぎて
   * 買い物の手配が無くなっても、使う日の前の日の「持って行く物」を出すのに使う。
   */
  bought: z.boolean().optional(),
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
    /**
     * 家族が進める案の作業に、ほかに進める案の作業と同じ人の時間で重ならない時刻を、今の探し方では見つけられ
     * なかった（refs：案の key。無いとは言わない。鎖ごとの並べ方だけを試し、手順を互い違いに置く置き方は
     * 探さない）。その案の作業には時刻を置かない（重ねて置かない）。どうするかは家族が決める。
     */
    'timeConflict',
    /** 祝日のデータの範囲の外の日がある（refs：日付）。 */
    'holidayDataMissing',
    /** 家庭の情報が足りない（refs：足りない物の名前）。 */
    'inputMissing',
    /** 選んだ案の依頼が断られた（refs：requestId）。予備へ移るか、選び直す。 */
    'turnedDown',
    /** 選んだ案を、決め時を過ぎても始めていない（refs：案の key）。予備へ移るか、選び直す。 */
    'missedDeadline',
    /**
     * 窓の「すること」で、受け持つと言えない時間がある（refs：「始まり/終わり」の時刻の対）。引き受けた受け持ち
     * の作業か、同じ窓に「はい」の返事のある依頼（やり方の covers の内）で覆った所の残り。
     */
    'notCovered',
  ]),
  refs: z.array(z.string()),
});
export type Reason = z.infer<typeof Reason>;

/**
 * 通用の「すること」の手配のキーか（engine の keys.needArrangement と同じ形）。手配が計画から消えた後も、依頼の根拠の
 * キーで見分ける（取り消しの連絡の文を、子の居場所の文にしない）。
 */
export const isNeedArrangementKey = (key: string | undefined): boolean =>
  key?.startsWith('arr:need:') ?? false;

/** 手配：手当てが要る事（例：12/7 8:10〜18:15 の子の居場所）。 */
export const Arrangement = z.object({
  key: z.string().min(1),
  requirementKey: z.string().min(1),
  kind: z.enum(['childCare', 'purchase', 'need']),
  childId: Id.optional(),
  start: DateTime,
  end: DateTime,
  status: PlanStatus,
  recommendedOptionKey: z.string().optional(),
  /**
   * 勧める理由（決まりで選ぶ）。onlyOption：選べる案が一つ。lowerCost：代償（休みの時間、人に頼む数、
   * 費用、増える作業）が一番小さい。moreTime：代償の同じ案の中で、決め時まで一番余裕がある。
   */
  recommendedReason: z.enum(['onlyOption', 'lowerCost', 'moreTime']).optional(),
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
  /**
   * 買い物の手配だけ：家にあるかの未定の値。問いが消えた後（家に無いと答えた後）も、ほかの手で用意
   * できたら、この値に「ある」と答えて手配を閉じる。
   */
  atHomeUnknownId: Id.optional(),
  /**
   * 通用の「すること」の手配だけ：形。window なら start–end は受け持つ窓（依頼の控えに窓を写し、窓が替われば
   * 確かめてもらう）。by なら start は今で、end は締切（窓ではない）。
   */
  needShape: z.enum(['by', 'window']).optional(),
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
   * 根拠の条件：式の形（節点の ID を除いた式）、式が使う未定の値の名前（画面に添える名前）、根拠が今
   * 確かでないか（直した文をまだ読み直していない・取り消されるかもしれない）。条件が無く確かな作業には
   * 付けない。引き受けの控えに写し、どれかが替われば見せ直す。未定の値に答えが出ただけなら替わらない。
   */
  condition: z.string().min(1).optional(),
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
   * やり方の受け持ちの作業（窓の「すること」）。窓の間その人の時間を使う（その間ほかの作業をしない）。引き受けた
   * 時だけ、その人が窓を受け持つと言える。
   */
  cover: z.literal(true).optional(),
  /**
   * 通用の「すること」の作業だけ：「すること」の中身とやり方の版の要約（needWaysBasis）。引き受けと済みの控えに
   * 入り、今と違えば前の引き受け・済みを当てない（だれのため・日・やり方が替わっても、題と時刻は同じことがある）。
   */
  about: z.string().min(1).optional(),
  /**
   * 案の手順の担当が、前後で別の人になっている。紙の受け渡しなどの時間と方法が分からないので、
   * 時刻を置かない（零分で手渡せるとは言わない）。同じ人が続けてするか、家族が受け渡しを決める。
   */
  handoff: z.boolean().optional(),
  /**
   * お知らせに書かれた時刻の決まり（家の人の当番と、日の書かれていない家の人がすること）。無ければ、仕組みが
   * 締切までの空いた時間に置く作業。
   * - fixed：書かれた時刻にする（earliestStart から deadline まで、その時間。前にも後にもずらさない）。
   * - fixedEndEstimated：始まりだけが書かれ、終わりは書かれていない（読めない）。deadline は目安の長さ。
   * - day：日だけが書かれ、時刻が無い（その日のどこか）。時刻に置かず、時刻なしで引き受ける。
   * - undated：日も書かれていない。時刻に置かず、時刻なしで引き受ける（締切を作らない）。
   * 決まった時刻の作業を置く時も、場所と行き帰りは入れない（atPlaceId を付けない。地図で確かめる前）。
   */
  timing: z.enum(['fixed', 'fixedEndEstimated', 'day', 'undated']).optional(),
  /**
   * 当番の対象に家の子の名前が無く、うちの番か分からない（保護者全員、名字、呼び名など）。対象の原文を
   * 添えて見せ、家族が「うちの番ではない」と言えるようにする。家族が「うちの番です」と言えば付けない。
   */
  turnUnconfirmed: z.literal(true).optional(),
  /**
   * 日だけの当番のうち、読み取りの始まりの時刻を確かめられなかった物（書き方を読み取れなかっただけで、
   * 書かれているかもしれない）。画面は「書かれていない」と言わず、元の文で確かめてもらう。知らせは、
   * その日の始まりまでに誰かが持つように早める（書かれた始まりとしては扱わない）。
   */
  timeUnconfirmed: z.literal(true).optional(),
});
export type Task = z.infer<typeof Task>;

/** 時刻なしで引き受ける作業（書かれた時刻が無い。仕組みが時刻を作らない）。 */
export const untimed = (task: Pick<Task, 'timing'>): boolean =>
  task.timing === 'day' || task.timing === 'undated';

/** 家族が決める値の、値ごとに要る要件（その値なら要る、または要るかもしれない要件の key）。 */
export const QuestionChoice = z.object({
  value: z.string().min(1),
  /** この値なら要る（要るかもしれない）要件。 */
  requirementKeys: z.array(z.string()),
  /** requirementKeys のうち、この値でもほかの条件（ほかの未定の値・効くか分からない作用）しだいの物。 */
  conditionalKeys: z.array(z.string()),
});
export type QuestionChoice = z.infer<typeof QuestionChoice>;

/**
 * 問い（§6）：答えで決め方が変わる時だけ、決め時より前に聞く。家にあるか（持ち物）の問いは askBy と
 * fallbackValue を持ち、affects は手配の key。家族が決める値（参加するか等）の問いは family を持ち、askBy と
 * fallbackValue は持たない（安全な既定は無い）。affects は要件の key、until は答えが要る最後の時。
 */
export const Question = z.object({
  key: z.string().min(1),
  unknownId: Id,
  toMemberId: Id.optional(),
  /** 聞く目安の時（家にあるかの問い）。 */
  askBy: DateTime.optional(),
  /** 答えが要る最後の時（答えで変わる要件の、まだ過ぎていない最も早い期限）。無ければ期限の分からない問い。 */
  until: DateTime.optional(),
  /** 期限までに答えが無い時に進む側（間に合わなくならない側）。家族が決める値には無い。 */
  fallbackValue: z.string().min(1).optional(),
  /** 答えで変わる手配・要件の key。 */
  affects: z.array(z.string()),
  /**
   * 家族が決める値：お知らせの言葉の名前と、値ごとに要る要件（「参加するなら：申込書（11/30まで）」）。
   * previous は、前に答えたが、答えた後に問いや事項が替わって使わなくなった値（聞き直す時に添える）。
   */
  family: z
    .object({
      label: z.string().min(1),
      choices: z.array(QuestionChoice).min(2),
      previous: z.string().min(1).optional(),
    })
    .optional(),
});
export type Question = z.infer<typeof Question>;

/**
 * 引き受けた作業が、もう要らなくなった（後のお知らせの取り消し、条件が外れた、事項を外した、家の決まりが
 * 変わった等で、今の計画に無いか、生きていない）。本人に知らせ、本人が分かったと言う（引き受けの取り下げ）
 * まで出す。用件と時刻は、本人が引き受けた時の控え（後で作業が変わっていても、約束した物を見せる）。控えの
 * 無い古い引き受けは、用件も時刻も分からないとする（今の作業を、前の約束として見せない）。時刻のある物は、
 * その時刻が過ぎたら出さない。
 */
export const Released = z.object({
  taskKey: z.string().min(1),
  assigneeId: Id,
  /** 引き受けた時の用件。無ければ、控えが無く分からない。 */
  content: z
    .object({ titleKey: z.string().min(1), titleParams: z.record(z.string(), z.string()) })
    .optional(),
  /** 引き受けた時に置いた始まり・終わり（時刻なしで引き受けた物と、控えの無い物は無し）。 */
  start: DateTime.optional(),
  end: DateTime.optional(),
  /**
   * gone：今の計画に無い（取り消し・取り下げ・外した等で、はっきり要らない）。notLive：あるが生きていない
   * （条件が外れた等）。inactive：生きているが、家族が別の案を選んだ・本命が決まった等で、その案の作業を
   * もう進めない（isActiveTask）。unconfirmed：今の計画に無いが、根拠のお知らせを消した・根拠が分からない
   * （古い引き受け）ので、要らなくなったとは言えない（まだ要るか確かめてもらう。消したお知らせの中身は出さない）。
   */
  reason: z.enum(['gone', 'notLive', 'inactive', 'unconfirmed']),
});
export type Released = z.infer<typeof Released>;

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
  /** 引き受けたのに、もう要らなくなった作業（本人が分かったと言うまで）。無ければ無し。 */
  released: z.array(Released).optional(),
  diff: Diff.optional(),
});
export type PlanResult = z.infer<typeof PlanResult>;
