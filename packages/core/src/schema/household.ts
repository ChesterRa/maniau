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
  /** 子の学年（例：小1）。 */
  grade: z.string().optional(),
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

export const Household = z.object({
  id: Id,
  /** 地域。日本だけのうちは JP。地域を差し替える仕組みは作らない（§13）。 */
  region: z.literal('JP'),
  timeZone: z.literal('Asia/Tokyo'),
  members: z.array(Member).min(1),
  places: z.array(Place),
  routines: z.array(RoutineDay),
  careOptions: z.array(CareOptionTemplate),
  /** 勤務先などの休み（営業日の計算に使う）。 */
  closedDates: z.array(LocalDate).default([]),
});
export type Household = z.infer<typeof Household>;
