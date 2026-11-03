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
});
export type RoutineDay = z.infer<typeof RoutineDay>;

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

/** 案を選ぶと払う物（§3 代償）。 */
export const Cost = z.object({
  leaveMinutes: z.number().int().nonnegative().default(0),
  helperRequests: z.number().int().nonnegative().default(0),
  yen: z.number().int().nonnegative().default(0),
  extraTasks: z.number().int().nonnegative().default(0),
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
  /** 後で取り消せるか。 */
  cancellable: z.boolean(),
});
export type Way = z.infer<typeof Way>;

export const Household = z.object({
  id: Id,
  /** 地域。日本だけのうちは JP。地域を差し替える仕組みは作らない（§13）。 */
  region: z.literal('JP'),
  timeZone: z.literal('Asia/Tokyo'),
  members: z.array(Member).min(1),
  places: z.array(Place),
  routines: z.array(RoutineDay),
  careOptions: z.array(CareOptionTemplate),
  /** 通用の「すること」のやり方（家族が確かめた物）。 */
  ways: z.array(Way).default([]),
  /** 勤務先などの休み（営業日の計算に使う）。 */
  closedDates: z.array(LocalDate).default([]),
});
export type Household = z.infer<typeof Household>;
