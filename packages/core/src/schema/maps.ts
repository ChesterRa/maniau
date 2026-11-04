// 地図（Google Maps）から、計算一回のために引いた根拠（02-foundation §2.3）。
// 家庭の正本（householdSet）とは別の入力で、事象・DB・ログ・Claude の入力には入れない。保存してよいのは
// place ID だけ（Google の条件）。同じ要求の中の計算・画面・検証は、同じ根拠を使う。別の要求では引き直す。
import { z } from 'zod';
import { DateTime, LocalDate, LocalTime } from '../time';
import { Id, OpeningPeriod } from './household';

/** 日付のある営業の区間（店の時区の現地日付と時刻）。 */
export const DatedPeriod = z.object({ date: LocalDate, open: LocalTime, close: LocalTime });
export type DatedPeriod = z.infer<typeof DatedPeriod>;

/**
 * 照会の日から数日の営業時間（Google の currentOpeningHours。臨時の営業を含む）。
 * [validFrom, validTo) の日だけ確か。その日に区間が無ければ、その日は閉まっている。
 */
export const CurrentHours = z.object({
  timeZone: z.string().min(1),
  validFrom: LocalDate,
  /** この日を含まない。 */
  validTo: LocalDate,
  periods: z.array(DatedPeriod),
});
export type CurrentHours = z.infer<typeof CurrentHours>;

/** ふだんの週の営業時間（Google の regularOpeningHours）。その日に開いているかは確かめていない（目安）。 */
export const RegularHours = z.object({
  timeZone: z.string().min(1),
  periods: z.array(OpeningPeriod),
});
export type RegularHours = z.infer<typeof RegularHours>;

/** 結果と一緒に見せなければならない、データの提供者（Google の attributions。見せるだけ）。 */
export const PlaceAttribution = z.object({
  provider: z.string().min(1),
  /** 提供者の URL（http・https の物だけ）。 */
  providerUri: z
    .string()
    .regex(/^https?:\/\//i)
    .optional(),
});
export type PlaceAttribution = z.infer<typeof PlaceAttribution>;

/** 家庭の店一つの、地図の根拠。 */
export const StoreMapEvidence = z.object({
  /** 家庭の店の Place の id。 */
  storeId: Id,
  googlePlaceId: z.string().min(1),
  /** 道のりの駅（家庭の Place の id と、その Google の place ID）。店の nearStationId と同じであること。 */
  stationId: Id,
  stationGooglePlaceId: z.string().min(1),
  /** 徒歩（分、切り上げ）。駅 → 店と、店 → 駅を別々に照会した。 */
  walkFromStationMin: z.number().int().nonnegative(),
  walkToStationMin: z.number().int().nonnegative(),
  /** Google での店の名前（画面に出すだけ。出典を添える。計算には使わない）。 */
  name: z.string().min(1).optional(),
  /** 名前・営業時間と一緒に見せる、データの提供者（返った時だけ）。 */
  attributions: z.array(PlaceAttribution).optional(),
  /** 営業時間。返らなかった方は無い（無いのは「分からない」で、閉まっているではない）。 */
  current: CurrentHours.optional(),
  regular: RegularHours.optional(),
});
export type StoreMapEvidence = z.infer<typeof StoreMapEvidence>;

export const MapInputs = z.object({
  /** Google に照会した実際の時刻。デモの進めた時計とは別。 */
  checkedAt: DateTime,
  stores: z.array(StoreMapEvidence),
});
export type MapInputs = z.infer<typeof MapInputs>;

/** 作業を置いた時に、店の営業時間を何で確かめたか。 */
export const HoursBasis = z.enum(['family', 'mapsCurrent', 'mapsRegular']);
export type HoursBasis = z.infer<typeof HoursBasis>;
