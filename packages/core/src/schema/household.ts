// 家庭・成員・場所・ふだんの週・取れる手の決まり（docs/design/01-model.md §2.1・§3）。
// 家庭がデータを分ける単位。地域・時区・祝日・学校の決まりは、画面の言葉と分けてデータで持つ（§13）。
import { z } from 'zod';
import { DateTime, LocalDate, LocalTime, Weekday } from '../time';

export const Id = z.string().min(1);
export type Id = z.infer<typeof Id>;

/** 画面の言葉と、外に出す文の言葉。 */
export const Language = z.enum(['ja', 'en']);
export type Language = z.infer<typeof Language>;

export const MemberKind = z.enum(['adult', 'child', 'helper']);
export type MemberKind = z.infer<typeof MemberKind>;

export const Member = z.object({
  id: Id,
  kind: MemberKind,
  name: z.string().min(1),
  /** 大人ごとの画面の言葉。 */
  uiLanguage: Language.optional(),
  /** 頼める人（祖母など）に出す文の言葉。分からなければ家族に聞く。 */
  outboundLanguage: Language.optional(),
  /** 外に出す文で、その人を呼ぶ言い方（例：お母さん）。無ければ name。 */
  addressAs: z.string().optional(),
  /** 子の学年（例：小1）。 */
  grade: z.string().optional(),
  /**
   * 子だけ：習い事・クラブ（お知らせの送り手が club）の行事に、大人が送るか（to）・迎えるか（from）。家族が
   * 決めて家族の情報に入れた家の決まりで、行事ごとの送り迎えの作業の根拠になる（書かれていない送り迎えを、
   * 推し量りで作らない）。無ければ作らない。今は、家庭の子が一人の時だけ使う（お知らせがどの子の物かを、
   * まだ結べないので）。
   */
  clubEscort: z.object({ to: z.boolean(), from: z.boolean() }).optional(),
  /** 止めた成員は、権限を持たない（§2.1）。 */
  active: z.boolean().default(true),
});
export type Member = z.infer<typeof Member>;

export const PlaceKind = z.enum([
  'home',
  'school',
  'afterSchoolCare',
  'workplace',
  'station',
  'store',
  'helperHome',
  'other',
]);
export type PlaceKind = z.infer<typeof PlaceKind>;

export const OpeningPeriod = z.object({
  weekday: Weekday,
  open: LocalTime,
  close: LocalTime,
});
export type OpeningPeriod = z.infer<typeof OpeningPeriod>;

/** 営業時間。出典と調べた時刻を持つ。未来の日に当てはまるかは「要確認」として扱う。 */
export const OpeningHours = z.object({
  periods: z.array(OpeningPeriod),
  closedDates: z.array(LocalDate).default([]),
  source: z.enum(['family', 'officialSite', 'googlePlaces', 'demo']),
  checkedAt: DateTime.optional(),
});
export type OpeningHours = z.infer<typeof OpeningHours>;

export const Place = z.object({
  id: Id,
  kind: PlaceKind,
  name: z.string().min(1),
  /** 町や駅の粒度でよい。番地は持たない。 */
  area: z.string().optional(),
  /** 最寄りの駅（駅の Place の id）。 */
  nearStationId: Id.optional(),
  /** 地図の place ID と調べた時刻だけを持つ（条款）。 */
  googlePlaceId: z.string().optional(),
  lookedUpAt: DateTime.optional(),
  hours: OpeningHours.optional(),
  /** 店で扱う品物の種類（家族が登録した物、または推定を家族が確かめた物）。 */
  goods: z.array(z.string()).default([]),
  /** 駅から歩いて寄る時の片道（分）。地図で確かめていなければ目安。 */
  walkFromStationMin: z.number().int().nonnegative().optional(),
});
export type Place = z.infer<typeof Place>;

/**
 * 店の goods に入る、品物の種類の名前（服・子ども服・食材）。goods のほかの字は、家族がその品物のために選んだ店の印
 * （品物の名前そのもの）。品物の名前がこの種類の名前と同じ字なら、その種類として扱う（品物のために選んだ店とは見なさない）。
 */
export const GOODS_KINDS: ReadonlySet<string> = new Set(['clothing', 'kidsClothing', 'groceries']);

/** ふだんの週の区間の種類。区間に無い時刻は、作業を置けない時刻として扱う。 */
export const SegmentKind = z.enum(['home', 'commute', 'work', 'pickup', 'away']);
export type SegmentKind = z.infer<typeof SegmentKind>;

export const TravelMode = z.enum(['train', 'walk', 'bike', 'car', 'bus']);
export type TravelMode = z.infer<typeof TravelMode>;

export const RoutineSegment = z.object({
  start: LocalTime,
  end: LocalTime,
  kind: SegmentKind,
  /** home・work・pickup・away の場所。 */
  placeId: Id.optional(),
  /** commute の出発と到着。 */
  fromId: Id.optional(),
  toId: Id.optional(),
  mode: TravelMode.optional(),
  /** commute で通る駅（寄り道の候補を探す所）。 */
  viaStationIds: z.array(Id).default([]),
});
export type RoutineSegment = z.infer<typeof RoutineSegment>;

/** 人ごと・曜日ごとのふだんの一日。 */
export const RoutineDay = z.object({
  memberId: Id,
  weekday: Weekday,
  segments: z.array(RoutineSegment),
  /**
   * 家族が、この一日の全部を確かめて記録した印（最初の区間の前と最後の区間の後は家にいて子を見られる、も含めて。
   * 記録した大人本人が答えたとは言わない）。日の記録の読み方は
   * 印があっても無くても同じ（一日の全部）。印の要る家庭（Household.confirmDays）で、新しく足す日の記録に要る。
   */
  allDay: z.literal(true).optional(),
});
export type RoutineDay = z.infer<typeof RoutineDay>;

/**
 * ある人のある日だけの一日（休む・その時間は外にいる・遅くなる等）。その日は、ふだんの曜日の一日の代わりに、
 * この区間の全部を使う（差分でなく一日の写し。ふだんの週を後で直しても、この日は変わらない）。同じ人・同じ日は
 * 一つ。外すと、その日はふだんに戻る。
 */
export const RoutineException = z.object({
  memberId: Id,
  date: LocalDate,
  segments: z.array(RoutineSegment).min(1),
  /** 家族が、この一日の全部を確かめて記録した印（RoutineDay.allDay と同じ）。 */
  allDay: z.literal(true).optional(),
});
export type RoutineException = z.infer<typeof RoutineException>;

/**
 * 手が離せない時間（家族が言った、大人のその日の時間。例：家で 9–10 時のオンライン会議）。その間、その人は子を
 * 見守れず、作業も置かない。場所の区間（ふだんの週・その日だけの一日）とは別の事実で、区間は切らない（その日だけの
 * 一日を外しても残り、逆も同じ）。半開 [start, end)、同じ日の中、分の精度。題や本文は持たない（何の用事かは
 * 計算に使わず、記録しない）。
 */
export const Unavailable = z.object({
  id: Id,
  memberId: Id,
  date: LocalDate,
  start: LocalTime,
  end: LocalTime,
});
export type Unavailable = z.infer<typeof Unavailable>;

/** 日の中の時間（半開 [start, end)、同じ日の中、分の精度）。 */
export const DaySpan = z.object({ start: LocalTime, end: LocalTime });
export type DaySpan = z.infer<typeof DaySpan>;

/**
 * 大人がその日、子を見られるかの、家族の答え（その大人について。一つの端末で、段取りを受け持つ人がもう一人の分も
 * 入れられる。だれが入れたかは事象の記録に残る）。見られる時間（can）・見られない時間（cannot）と、それ以外の時間
 * （rest）が見られる・見られない・分からない。子の見守りの計算では、その人のその日の区間（ふだんの週・その日だけの
 * 一日）より先に使う（作業を置く所は、今までどおり区間で決める）。「分からない」と答え直すのも答え（rest が
 * unknown で can・cannot が空）で、前の答えや区間をその日に戻さない。同じ人・同じ日は一つ。can と cannot は重ならない。
 * 手が離せない時間は、どちらに書いてあっても、いつも見られない時間に入る。使う所は子の居場所だけ：答えは「その子を
 * 見られるか」で、ほかの事ができる時間ではない（作業の置き場・いつにするか・買い物には使わない。02-foundation §3.7）。
 */
export const DayAnswer = z.object({
  memberId: Id,
  date: LocalDate,
  can: z.array(DaySpan),
  cannot: z.array(DaySpan),
  rest: z.enum(['can', 'cannot', 'unknown']),
});
export type DayAnswer = z.infer<typeof DayAnswer>;

/** 締切の決まり。手配が要る日から逆算する。 */
export const DeadlineRule = z.discriminatedUnion('type', [
  /** 例：祖母は3日前の 21:00 まで。 */
  z.object({ type: z.literal('daysBefore'), days: z.number().int().positive(), at: LocalTime }),
  /** 例：有休は3営業日前の 18:00 まで。 */
  z.object({
    type: z.literal('businessDaysBefore'),
    days: z.number().int().positive(),
    at: LocalTime,
  }),
  /** 例：学童の一日利用は、前の週の月曜日 18:30 まで。 */
  z.object({ type: z.literal('weekdayOfPreviousWeek'), weekday: Weekday, at: LocalTime }),
  /** 例：病児保育の確かめの電話は、当日の 7:30 まで。 */
  z.object({ type: z.literal('onTheDay'), at: LocalTime }),
]);
export type DeadlineRule = z.infer<typeof DeadlineRule>;

/** 外の相手の返事の種類。返事が要る手順の後は「返事待ち」になる。 */
export const ExternalKind = z.enum(['reply', 'approval', 'acceptance']);
export type ExternalKind = z.infer<typeof ExternalKind>;

/** 案の手順の雛形。 */
export const StepTemplate = z.object({
  id: Id,
  /** 画面の文言のキー（文を連結しない）。 */
  titleKey: z.string().min(1),
  durationMin: z.number().int().nonnegative(),
  /** 置いてよい区間の種類。 */
  segments: z.array(SegmentKind).min(1),
  /** 決まった場所（学童の窓口など）。 */
  placeId: Id.optional(),
  /** 場所の種類と品物（店で買う時）。 */
  placeKind: PlaceKind.optional(),
  goods: z.string().optional(),
  /** 外の相手に頼む手順なら、相手と返事の種類。 */
  external: z.object({ to: Id, kind: ExternalKind }).optional(),
  /** この手順の後、返事などを待つ時間（分）。 */
  waitAfterMin: z.number().int().nonnegative().default(0),
  /** 本人しかできない手順（自分の有休の申請など）。無ければ大人の誰でもよい。 */
  assigneeId: Id.optional(),
  /**
   * この手順の最後の時（手配の日から逆算）。無ければ、案の締切と次の手順で決まる。手順ごとに別に守る（前の日
   * 21:00 までの予約と、当日 7:30 までの確かめが、両方成り立つように）。
   */
  deadline: DeadlineRule.optional(),
});
export type StepTemplate = z.infer<typeof StepTemplate>;

/** 代償の欄（Cost の四つ）。 */
export const CostField = z.enum(['leaveMinutes', 'helperRequests', 'yen', 'extraTasks']);
export type CostField = z.infer<typeof CostField>;

/** 案を選ぶと払う物（§3 代償）。 */
export const Cost = z.object({
  leaveMinutes: z.number().int().nonnegative().default(0),
  helperRequests: z.number().int().nonnegative().default(0),
  yen: z.number().int().nonnegative().default(0),
  extraTasks: z.number().int().nonnegative().default(0),
  /**
   * 家族が「分からない」とした欄（やり方だけ）。その欄の値は 0 にするが、分かった 0 ではない：画面は「分からない」と
   * 書き、費用で比べたお勧めを出さない（plan の withStatus）。無いのは、どの欄も分かっている（初めに入れた家の
   * 情報と同じ扱い）。
   */
  unknown: z.array(CostField).optional(),
});
export type Cost = z.infer<typeof Cost>;

/** 取れる手（子の居場所の手配を満たす方法の種類と、その決まり）。 */
export const CareOptionTemplate = z.object({
  id: Id,
  kind: z.enum(['afterSchoolFullDay', 'paidLeave', 'hourlyLeave', 'askHelper']),
  titleKey: z.string().min(1),
  /** 学童の場所、頼める人、勤務先など。 */
  providerId: Id.optional(),
  deadline: DeadlineRule,
  steps: z.array(StepTemplate).min(1),
  /** 案を選ぶと増える準備（学童の日のお弁当など）。日付は手配の日に対する日数で置く。 */
  extraSteps: z.array(StepTemplate.extend({ dayOffset: z.number().int().max(0) })).default([]),
  cost: Cost,
  /** 後で取り消せるか（予備に出せるか）。 */
  cancellable: z.boolean(),
});
export type CareOptionTemplate = z.infer<typeof CareOptionTemplate>;

/** やり方の手順。題は家族が書いたデータの文（画面の文言の鍵ではない）。ほかは案の手順と同じ。 */
export const WayStep = StepTemplate.omit({ titleKey: true }).extend({
  name: z.string().min(1),
  /**
   * この手順をする人が、窓の間を受け持つ（窓の「すること」だけ）。
   * - 外の相手に頼む手順（external）なら、相手が受け持つ：その窓・今の中身への「はい」が、相手が受け持つという
   *   証拠になる（病児保育の予約、祖母に来てもらう）。頼むのは前もってで、作業は窓の前に置く。
   * - そうでなければ家族が受け持つ：その人のふだんの予定が、窓の間ずっと手順の区間（家など）にある時だけ、その回の
   *   窓の時刻に置き（durationMin は使わない。仕事の時間には置かない）、その間その人はほかの作業をしない（ほかの
   *   こともしながら受け持てる、は今週は言えない）。引き受けた時だけ、その人が窓を受け持つと言える。
   * 受け持ちの無い外の相手の手順（休みの承認など）は前提で、「はい」でもだれかが受け持つことにはならない。
   */
  cover: z.literal(true).optional(),
});
export type WayStep = z.infer<typeof WayStep>;

/**
 * やり方（通用の「すること」を満たす手立て。家族が確かめたデータ。02-foundation §3.4）。名前と手順の題は家族の
 * 言葉で、場面の種類を持たない（熱・印刷などで分岐しない）。どの「すること」に使うかは、家族が選ぶ。
 */
export const Way = z.object({
  id: Id,
  name: z.string().min(1),
  /** 案の締切（最初の手順の始まりの最後。無ければ手順ごとの締切と「すること」の締切・窓で決まる）。 */
  deadline: DeadlineRule.optional(),
  steps: z.array(WayStep).min(1),
  /**
   * 窓の「すること」で、前もって分かっている受け持てる時間（例：病児保育は 8:30–17:30）。無くてもよい（外の
   * 相手が窓の全部に「はい」と答えれば覆う）。窓の一部しか覆わなければ、覆ったと言わず、足りない時間を出す。
   */
  covers: z.object({ start: LocalTime, end: LocalTime }).optional(),
  cost: Cost,
  /** 後で取り消せるか（初めに入れた家の情報だけ。今は計算にも画面にも使わない。家族が足すやり方では聞かない）。 */
  cancellable: z.boolean().optional(),
  /**
   * このやり方を使う前に済ませておく前提（Preparation の id。事前の登録など）。済んでいなければ、案に印を付けて
   * 勧めない（家族は選べる）。いくつのやり方が同じ前提を指しても、前提は家に一つ。
   */
  requires: z.array(Id).optional(),
  /**
   * このやり方が使う周りの資源（Resource の id。病児保育室など）。家族が「使わない」とした資源を使うやり方の案は
   * 勧めない（家族は選べる）。前提（requires）からは使う資源を推し量らない（前提の資源を使うとは限らない）。
   */
  resourceIds: z.array(Id).optional(),
});
export type Way = z.infer<typeof Way>;

/**
 * 調べた事の出典。ウェブの頁なら、URL・頁の題と、頁を読んだ時刻、Claude が根拠に挙げた文（引用）が読んだ頁の本文に
 * 文字のとおりにあったか（コードが照らした結果）。引用（頁から抜き出した文）は持たない（照らすためにだけ使う。2026-11-05）。前の形の
 * 記録に引用があっても、読む時に落とす。頁が公式かは、コードでは確かめない（家族がリンク先で確かめる）。
 */
export const ResourceSource = z.object({
  /** webPage：調べて読んだウェブの頁。family：家族が言った。demo：デモのために作った架空の決まり（本当の頁ではない）。 */
  kind: z.enum(['webPage', 'family', 'demo']),
  url: z.string().url().optional(),
  title: z.string().optional(),
  fetchedAt: DateTime.optional(),
  quoteFound: z.boolean().optional(),
});
export type ResourceSource = z.infer<typeof ResourceSource>;

/**
 * 周りの資源（家の周りの施設・サービス。02-foundation §3.5）。種類（kind）はデータで、計算も検証も種類で分けない。
 * 調べた候補は、家族が「この家の候補にする」を押した時だけ入る（調べただけでは入れない）。入れても、登録が済んだ・
 * 使える・その日に空いている、とは言わない（それぞれ別の事実）。
 */
export const Resource = z.object({
  id: Id,
  kind: z.string().min(1),
  name: z.string().min(1),
  /** 区や駅の粒度。番地は持たない。 */
  area: z.string().optional(),
  /** 地図の場所（Place）に結ぶ時。 */
  placeId: Id.optional(),
  /** 調べて分かった事（家族に見せる文と、その出典）。計算には使わない。 */
  notes: z.array(z.object({ text: z.string().min(1), source: ResourceSource })).default([]),
  /** 家族の扱い：いつも使う・候補・使わない。家族が決める（調べ直しで替えない）。 */
  use: z.enum(['usual', 'candidate', 'notUsed']),
  /** 家族が扱いを決めた時刻。 */
  decidedAt: DateTime.optional(),
});
export type Resource = z.infer<typeof Resource>;

/**
 * 一度だけ済ませておく前提（事前の登録・会員の登録・申込など）。状態は家族が確かめて入れる（調べた候補からは
 * 「済んだ」にしない）。
 */
export const Preparation = z.object({
  id: Id,
  /** 家族の言葉の名前（例：病児保育の事前登録）。 */
  name: z.string().min(1),
  resourceId: Id.optional(),
  /** この前提が要ると分かった出典（調べた頁の引用など）。 */
  source: ResourceSource.optional(),
  /**
   * だれの前提か。household：家全体（家族がそう言った時だけ）。members：その人たちだけ。unknown：まだ分からない
   * （済んでも、どの「すること」にも借りない）。欄が無いことを家全体とは読まない。
   */
  appliesTo: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('household') }),
    z.object({ kind: z.literal('members'), memberIds: z.array(Id).min(1) }),
    z.object({ kind: z.literal('unknown') }),
  ]),
  /** unknown：分からない。notDone：まだ。inProgress：手続き中。done：済んだ。 */
  state: z.enum(['unknown', 'notDone', 'inProgress', 'done']),
  /** 家族が状態を確かめた時刻（出典を読んだ時刻とは別）。 */
  stateCheckedAt: DateTime.optional(),
  /** 済んだ前提が有効な最後の日（年度の終わり等。分かっている時だけ）。 */
  validUntil: LocalDate.optional(),
  /**
   * 使う日の何日前（暦の日）までに済ませるか。家族が出典の原文を見て確かめた時だけ持つ。今は「使う日の N 日前
   * （暦の日）」だけを持ち、営業日や時刻つきの締切は持たない（そう書かれていれば持たず、「早めに確かめる」とだけ
   * 言う）。
   */
  lead: z
    .object({
      days: z.number().int().positive().max(366),
      from: z.literal('useDate'),
      unit: z.literal('calendarDays'),
      source: ResourceSource,
      confirmedAt: DateTime,
    })
    .optional(),
});
export type Preparation = z.infer<typeof Preparation>;

export const Household = z.object({
  id: Id,
  /** 地域。日本だけのうちは JP。地域を差し替える仕組みは作らない（§13）。 */
  region: z.literal('JP'),
  timeZone: z.literal('Asia/Tokyo'),
  members: z.array(Member).min(1),
  places: z.array(Place),
  routines: z.array(RoutineDay),
  /** その日だけの一日（ふだんの週より先に使う）。 */
  routineExceptions: z.array(RoutineException).default([]),
  /** 手が離せない時間。無いのは、記録した物が無い（前からの記録に欄を足さない）。 */
  unavailable: z.array(Unavailable).optional(),
  /** 大人がその日、子を見られるかの答え。無いのは、答えた物が無い（前からの記録に欄を足さない）。 */
  dayAnswers: z.array(DayAnswer).optional(),
  /**
   * この家庭では、日の記録（ふだんの週の一日・その日だけの一日）を新しく足す時、家族が一日の全部を確かめて記録した印
   * （allDay）が要る。空から始めた家庭に付ける。無いのは前からの家庭で、前からの記録は今までの決まりのまま読む。
   */
  confirmDays: z.literal(true).optional(),
  careOptions: z.array(CareOptionTemplate),
  /** 通用の「すること」のやり方（家族が確かめた物）。 */
  ways: z.array(Way).default([]),
  /**
   * 家族が「やめる」としたやり方の ID。これからは新しく選べない（選ぶ所に出さず、命令が断る）。やり方の中身（版）は
   * 替えないので、今選んである「すること」の選び・案・引き受け・依頼は、そのまま当たる（外すなら、その「すること」で
   * 選び直す）。やり方は消さない（前の選びと控えのために残す）。無いのは、やめた物が無い。
   */
  stoppedWayIds: z.array(Id).optional(),
  /** 勤務先などの休み（営業日の計算に使う）。 */
  closedDates: z.array(LocalDate).default([]),
  /** 周りの資源（家族が入れた物だけ）。 */
  resources: z.array(Resource).default([]),
  /** 一度だけ済ませておく前提。 */
  preparations: z.array(Preparation).default([]),
});
export type Household = z.infer<typeof Household>;

/** 家族が足せる「頼める人に頼む」の締切：その日の何日前の 21:00 までに頼むか（家族が選ぶ）。 */
export const HELPER_ASK_DAYS = [1, 3, 7] as const;

/**
 * 家族が足せる取れる手：頼める人に頼む（頼める人一人に一つ）。手順と代償は決まった形で、締切だけを家族が選ぶ
 * （HELPER_ASK_DAYS）。返事を待つ時間は置かない（相手の都合を、前もって決めない）。サーバーは、この形と同じ物だけを
 * 足させる（ほかの取れる手は、今までどおり足せない）。
 */
export function helperAskOption(
  id: string,
  helperId: string,
  days: (typeof HELPER_ASK_DAYS)[number],
): CareOptionTemplate {
  return CareOptionTemplate.parse({
    id,
    kind: 'askHelper',
    titleKey: 'option.askHelper',
    providerId: helperId,
    deadline: { type: 'daysBefore', days, at: '21:00' },
    steps: [
      {
        id: 'ask',
        titleKey: 'task.helper.ask',
        durationMin: 5,
        segments: ['home', 'commute', 'work'],
        external: { to: helperId, kind: 'reply' },
      },
    ],
    cost: { helperRequests: 1 },
    cancellable: true,
  });
}
