// 計算一回のための地図の根拠（MapInputs）を、家庭の店（place ID と駅のある物）について引く
// （02-foundation §2.3）。要求ごとに引き、要求をまたいで使い回さない（Google の条件：営業時間や所要時間を
// 取っておかない）。引けなかった店は根拠を持たず、エンジンは家庭の目安で置く。
import {
  addDays,
  type CurrentHours,
  type DatedPeriod,
  formatDateTime,
  type Household,
  isValidLocalDate,
  localDateOf,
  type MapInputs,
  type OpeningPeriod,
  type RegularHours,
  type StoreMapEvidence,
} from '@maniau/core';
import type { GooglePeriod, GooglePoint, MapsClient } from './google';

/** Google の currentOpeningHours が覆う日数（照会の日を含む）。 */
const CURRENT_DAYS = 7;

const pad = (n: number) => String(n).padStart(2, '0');
/** 省かれた 0 を 0 として読む。範囲の外なら読めない（undefined）。 */
const dayOf = (p: GooglePoint) => {
  const day = p.day ?? 0;
  return Number.isInteger(day) && day >= 0 && day <= 6 ? day : undefined;
};
const hhmm = (p: GooglePoint) => {
  const hour = p.hour ?? 0;
  const minute = p.minute ?? 0;
  const ok = Number.isInteger(hour) && hour >= 0 && hour <= 23 && Number.isInteger(minute);
  return ok && minute >= 0 && minute <= 59 ? `${pad(hour)}:${pad(minute)}` : undefined;
};
/** Google の曜日（0 が日曜）を、家庭の曜日（1 が月曜、7 が日曜）へ。 */
const weekday = (day: number) => (day === 0 ? 7 : day);
const ymd = (d: { year: number; month: number; day: number }) =>
  `${d.year}-${pad(d.month)}-${pad(d.day)}`;

/**
 * ふだんの週の営業時間。日をまたぐ区間は、その日の終わりまでと次の日の始まりからに分ける。
 * いつも開いている書き方（日曜 0:00 に開いて閉まらない）は毎日 0:00〜23:59。読めない形は分からない。
 */
export function regularOf(
  periods: readonly GooglePeriod[],
  timeZone: string,
): RegularHours | undefined {
  const out: OpeningPeriod[] = [];
  for (const p of periods) {
    const openDay = dayOf(p.open);
    const open = hhmm(p.open);
    if (openDay === undefined || open === undefined) return undefined;
    if (!p.close) {
      if (periods.length === 1 && openDay === 0 && open === '00:00') {
        return {
          timeZone,
          periods: [1, 2, 3, 4, 5, 6, 7].map((w) => ({
            weekday: w,
            open: '00:00',
            close: '23:59',
          })),
        };
      }
      return undefined;
    }
    const closeDay = dayOf(p.close);
    const close = hhmm(p.close);
    if (closeDay === undefined || close === undefined) return undefined;
    if (closeDay === openDay && close > open) {
      out.push({ weekday: weekday(openDay), open, close });
    } else if ((openDay + 1) % 7 === closeDay) {
      out.push({ weekday: weekday(openDay), open, close: '23:59' });
      if (close !== '00:00') out.push({ weekday: weekday(closeDay), open: '00:00', close });
    } else {
      return undefined;
    }
  }
  return { timeZone, periods: out };
}

/**
 * 照会の日から数日の営業時間（臨時の営業を含む）。覆う日は [照会の日, 照会の日 + 7)（店の時区）。その内で
 * 区間の無い日は閉まっている。日付の無い区間・読めない形があれば、全体を分からないとする（覆ったと言わない）。
 */
export function currentOf(
  periods: readonly GooglePeriod[],
  timeZone: string,
  nowMinutes: number,
): CurrentHours | undefined {
  const validFrom = localDateOf(nowMinutes, timeZone);
  const validTo = addDays(validFrom, CURRENT_DAYS);
  const out: DatedPeriod[] = [];
  for (const p of periods) {
    if (!p.open.date || !p.close?.date) return undefined;
    const from = ymd(p.open.date);
    const to = ymd(p.close.date);
    const open = hhmm(p.open);
    const close = hhmm(p.close);
    if (open === undefined || close === undefined) return undefined;
    if (!isValidLocalDate(from) || !isValidLocalDate(to)) return undefined;
    if (from === to && close > open) {
      out.push({ date: from, open, close });
    } else if (addDays(from, 1) === to) {
      out.push({ date: from, open, close: '23:59' });
      if (close !== '00:00') out.push({ date: to, open: '00:00', close });
    } else {
      return undefined;
    }
  }
  return {
    timeZone,
    validFrom,
    validTo,
    periods: out.filter((p) => validFrom <= p.date && p.date < validTo),
  };
}

/**
 * 家庭の店ごとに、駅 → 店・店 → 駅の徒歩（分、切り上げ）と営業時間を引く。地図に結び付く店が無ければ
 * undefined。道のりが引けなければ（失敗・上限）全体を投げる（呼ぶ側が家庭の目安に戻す）。営業時間が
 * 引けない店は、営業時間の根拠を持たない（分からない）。
 */
/**
 * 地図の根拠を引く家庭：今の家庭に、直した後の家庭の場所を重ねた物（同じ ID は直した後の物。外した場所も残す）。
 * 根拠は店と駅の ID と place ID が合う時だけ使われるので、前と後のどちらの計算にも、合う物だけが効く。
 */
export function withProposed(current: Household, proposed: Household | undefined): Household {
  if (!proposed) return current;
  const ids = new Set(proposed.places.map((p) => p.id));
  return {
    ...current,
    places: [...proposed.places, ...current.places.filter((p) => !ids.has(p.id))],
  };
}

export async function mapInputsFor(
  household: Household,
  client: MapsClient,
  clock: () => number = Date.now,
): Promise<MapInputs | undefined> {
  const pairs = household.places.flatMap((store) => {
    if (store.kind !== 'store' || !store.googlePlaceId || !store.nearStationId) return [];
    const station = household.places.find((p) => p.id === store.nearStationId);
    if (!station?.googlePlaceId) return [];
    return [{ store, station, storeG: store.googlePlaceId, stationG: station.googlePlaceId }];
  });
  if (pairs.length === 0) return undefined;
  const nowMinutes = Math.floor(clock() / 60_000);
  const stations = [...new Set(pairs.map((p) => p.stationG))];
  const stores = [...new Set(pairs.map((p) => p.storeG))];
  const [there, back, details] = await Promise.all([
    client.walkMatrix(stations, stores),
    client.walkMatrix(stores, stations),
    Promise.all(
      stores.map((id) => client.place(id, { hours: true, summary: true }).catch(() => undefined)),
    ),
  ]);
  const detailsOf = new Map(details.flatMap((d) => (d ? [[d.id, d] as const] : [])));
  const evidence = pairs.flatMap(({ store, station, storeG, stationG }): StoreMapEvidence[] => {
    const from = there.get(`${stationG}>${storeG}`);
    const to = back.get(`${storeG}>${stationG}`);
    if (from === undefined || to === undefined) return [];
    const d = detailsOf.get(storeG);
    const tz = d?.timeZone;
    const regular = tz && d?.regular ? regularOf(d.regular, tz) : undefined;
    const current = tz && d?.current ? currentOf(d.current, tz, nowMinutes) : undefined;
    return [
      {
        storeId: store.id,
        googlePlaceId: storeG,
        stationId: station.id,
        stationGooglePlaceId: stationG,
        walkFromStationMin: Math.ceil(from / 60),
        walkToStationMin: Math.ceil(to / 60),
        ...(d?.name ? { name: d.name } : {}),
        ...(d?.attributions ? { attributions: d.attributions } : {}),
        ...(current ? { current } : {}),
        ...(regular ? { regular } : {}),
      },
    ];
  });
  if (evidence.length === 0) return undefined;
  return { checkedAt: formatDateTime(nowMinutes, household.timeZone), stores: evidence };
}
