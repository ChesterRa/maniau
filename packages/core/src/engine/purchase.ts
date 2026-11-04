// 買い物を、ふだんの週の中に置く（docs/design/01-model.md §5）。
// 帰り道の寄り道：通勤の区間の終わりが家で、店が家の最寄りの駅の近くにある時だけ。
//   駅に着く時刻 = 通勤の終わり − 家の駅からの徒歩。そこから店へ歩き、買って駅へ戻り、家へ歩く。
//   家に着くのが遅れる分は、続く家の区間（空いた時間）を短くする。次がお迎えなら寄らない。
//   遅れる間、他の大人が家にいる時だけ寄る。遅く帰ってよいかは、担当の人が引き受けて確かめる。
// 週末の外出：外出の区間の中で、その駅の近くの店へ行く。
// 移動の時間と営業時間は、地図の根拠（MapInputs）がその店・駅に結び付く時はそれを使い（travelSource maps）、
// 無ければ家庭の情報の目安（walkFromStationMin・hours）を使う。駅 → 店と店 → 駅は別々の分。
import type { Household, Place } from '../schema/household';
import type { HoursBasis, MapInputs, StoreMapEvidence } from '../schema/maps';
import type { EpochMinutes } from '../time';
import { localDateOf, weekdayOf, zonedToEpochMinutes } from '../time';
import { activeAdultIds, type Slot, slotsBetweenDates, slotsOn } from './availability';

export interface PurchaseOpportunity {
  memberId: string;
  storeId: string;
  start: EpochMinutes;
  end: EpochMinutes;
  travelBeforeMin: number;
  travelAfterMin: number;
  slotKind: 'commute' | 'away';
  /** 帰り道の寄り道なら、元の到家と、遅れた到家。 */
  detour?: { plannedArrival: EpochMinutes; delayedArrival: EpochMinutes };
  /** 移動の分の出どころ（maps：地図の根拠、estimate：家庭の目安）。 */
  travelSource: 'estimate' | 'maps';
  /** 営業時間を何で確かめて置いたか。 */
  hoursBasis: HoursBasis;
}

/** 店の機会を探した結果。置けなかった理由に、確かめていない営業時間があったか。 */
export interface PurchaseSearch {
  opportunities: PurchaseOpportunity[];
  /**
   * 区間には置けたのに、確かめていない営業時間（地図のふだんの営業時間の目安・営業時間が分からない）で
   * 落とした機会があった。機会が無くても「無い」とは言い切れない。
   */
  droppedUnconfirmed: boolean;
}

/** 店の計算に使う道のりと根拠。 */
interface StoreRoute {
  store: Place;
  /** 駅 → 店、店 → 駅（分）。 */
  walkFrom: number;
  walkTo: number;
  travelSource: 'estimate' | 'maps';
  evidence?: StoreMapEvidence;
}

/**
 * 地図の根拠が、この家庭のこの店とその駅に結び付くか（店の id・Google の place ID・駅の id・駅の Google の
 * place ID が全部合う時だけ）。合わなければ使わない（別の店や駅の道のりを、この店に当てない）。
 */
export function evidenceFor(
  household: Household,
  store: Place,
  maps: MapInputs | undefined,
): StoreMapEvidence | undefined {
  if (!maps || store.googlePlaceId === undefined || store.nearStationId === undefined)
    return undefined;
  const station = household.places.find((p) => p.id === store.nearStationId);
  if (station?.googlePlaceId === undefined) return undefined;
  return maps.stores.find(
    (e) =>
      e.storeId === store.id &&
      e.googlePlaceId === store.googlePlaceId &&
      e.stationId === store.nearStationId &&
      e.stationGooglePlaceId === station.googlePlaceId,
  );
}

function routeOf(
  household: Household,
  store: Place,
  maps: MapInputs | undefined,
): StoreRoute | undefined {
  if (store.nearStationId === undefined) return undefined;
  const evidence = evidenceFor(household, store, maps);
  if (evidence) {
    return {
      store,
      walkFrom: evidence.walkFromStationMin,
      walkTo: evidence.walkToStationMin,
      travelSource: 'maps',
      evidence,
    };
  }
  const walk = store.walkFromStationMin;
  if (walk === undefined) return undefined;
  return { store, walkFrom: walk, walkTo: walk, travelSource: 'estimate' };
}

/** 地図で選んだ店で、この計算に地図の根拠も家庭の目安も無い（道のりが分からない。置けないとは言わない）。 */
function routeUnknown(household: Household, store: Place, maps: MapInputs | undefined): boolean {
  return (
    store.googlePlaceId !== undefined &&
    store.walkFromStationMin === undefined &&
    evidenceFor(household, store, maps) === undefined
  );
}

type Openness =
  | { status: 'open' | 'closed'; basis: HoursBasis }
  /** ふだんの営業時間の目安で閉まっている・営業時間が分からない（閉まっているとは言い切れない）。 */
  | { status: 'unconfirmed' };

const within = (
  date: string,
  open: string,
  close: string,
  tz: string,
  start: EpochMinutes,
  end: EpochMinutes,
) => zonedToEpochMinutes(date, open, tz) <= start && end <= zonedToEpochMinutes(date, close, tz);

/**
 * その時刻に店が開いているか。地図の根拠があれば、照会の日から数日の営業時間（その日の分が確か）、
 * 無ければふだんの営業時間（目安）。どちらも無ければ家庭の情報。何も無ければ分からない。
 */
function openness(route: StoreRoute, start: EpochMinutes, end: EpochMinutes, tz: string): Openness {
  const current = route.evidence?.current;
  if (current) {
    const date = localDateOf(start, current.timeZone);
    if (current.validFrom <= date && date < current.validTo) {
      const open = current.periods.some(
        (p) => p.date === date && within(date, p.open, p.close, current.timeZone, start, end),
      );
      return { status: open ? 'open' : 'closed', basis: 'mapsCurrent' };
    }
  }
  const regular = route.evidence?.regular;
  if (regular) {
    const date = localDateOf(start, regular.timeZone);
    const weekday = weekdayOf(date);
    const open = regular.periods.some(
      (p) => p.weekday === weekday && within(date, p.open, p.close, regular.timeZone, start, end),
    );
    return open ? { status: 'open', basis: 'mapsRegular' } : { status: 'unconfirmed' };
  }
  const hours = route.store.hours;
  // 地図の根拠があるのに営業時間が返らなかった店は、家庭の情報が無ければ分からない（閉まっているとは
  // 言わない）。地図の根拠の無い店で、家庭の情報に営業時間が無ければ、今までどおり置かない。
  if (!hours)
    return route.evidence ? { status: 'unconfirmed' } : { status: 'closed', basis: 'family' };
  const date = localDateOf(start, tz);
  if (hours.closedDates.includes(date)) return { status: 'closed', basis: 'family' };
  const weekday = weekdayOf(date);
  const open = hours.periods.some(
    (p) => p.weekday === weekday && within(date, p.open, p.close, tz, start, end),
  );
  return { status: open ? 'open' : 'closed', basis: 'family' };
}

/** 買い物を探す店の集まり（家族の好みで絞った物）。 */
export interface PurchaseStores {
  stores: Place[];
  /** 家族が「いつも使う」とした店だけに絞った。 */
  usual: boolean;
  /** 品物を扱うが、家族が「使わない」とした店。 */
  notUsed: Place[];
  /** いつもの店に絞った時の、ほかの使える店（「使わない」でない店。家族が選べば使える）。絞っていなければ空。 */
  others: Place[];
}

/**
 * 品物（の種類）を買う店の集まり（家族の好み。02-foundation §3.5）：扱う店から、家族が「使わない」とした店を外し、
 * 「いつも使う」とした店があれば、その店だけ（ほかの店が先に寄れても、ほかの店にしない）。家族の扱いは、店の場所を
 * 指す資源の use（店の資源は、一つの店に一つ）。「いつも使う」の店が無ければ、「使わない」を除いた店の全部。
 */
export function purchaseStores(household: Household, goods: string): PurchaseStores {
  const all = household.places.filter((p) => p.kind === 'store' && p.goods.includes(goods));
  const useOf = (store: Place) => household.resources.find((r) => r.placeId === store.id)?.use;
  const notUsed = all.filter((store) => useOf(store) === 'notUsed');
  const usable = all.filter((store) => useOf(store) !== 'notUsed');
  const usual = usable.filter((store) => useOf(store) === 'usual');
  return usual.length > 0
    ? { stores: usual, usual: true, notUsed, others: usable.filter((s) => !usual.includes(s)) }
    : { stores: usable, usual: false, notUsed, others: [] };
}

export function purchaseOpportunities(
  household: Household,
  goods: string,
  durationMin: number,
  from: EpochMinutes,
  until: EpochMinutes,
  maps?: MapInputs,
  stores: readonly Place[] = purchaseStores(household, goods).stores,
): PurchaseOpportunity[] {
  return searchPurchase(household, goods, durationMin, from, until, maps, stores).opportunities;
}

/**
 * 店の集まり（無ければ家族の好みで絞った物）の、大人ごとの機会。置いた店と決め時は、同じ集まりから求める（いつもの
 * 店にしか行かないのに、ほかの店の最後の機会を決め時にしない）。
 */
export function searchPurchase(
  household: Household,
  goods: string,
  durationMin: number,
  from: EpochMinutes,
  until: EpochMinutes,
  maps?: MapInputs,
  stores: readonly Place[] = purchaseStores(household, goods).stores,
): PurchaseSearch {
  const tz = household.timeZone;
  const routes = stores
    .map((store) => routeOf(household, store, maps))
    .filter((r): r is StoreRoute => r !== undefined);
  const result: PurchaseOpportunity[] = [];
  // 道のりの分からない店があれば、機会が無くても「無い」とは言い切れない。
  let droppedUnconfirmed = stores.some((store) => routeUnknown(household, store, maps));
  for (const memberId of activeAdultIds(household)) {
    const slots = slotsBetweenDates(
      household,
      memberId,
      localDateOf(from, tz),
      localDateOf(until, tz),
    );
    slots.forEach((slot, index) => {
      for (const route of routes) {
        const option = placeAt(household, slot, slots[index + 1], route, durationMin);
        if (!option) continue;
        const { start, end, detour } = option;
        if (start < from || end > until) continue;
        const open = openness(route, start, end, tz);
        if (open.status === 'unconfirmed') {
          droppedUnconfirmed = true;
          continue;
        }
        if (open.status === 'closed') continue;
        result.push({
          memberId,
          storeId: route.store.id,
          start,
          end,
          travelBeforeMin: route.walkFrom,
          travelAfterMin: route.walkTo,
          slotKind: slot.kind === 'commute' ? 'commute' : 'away',
          ...(detour ? { detour } : {}),
          travelSource: route.travelSource,
          hoursBasis: open.basis,
        });
      }
    });
  }
  return {
    opportunities: result.sort((a, b) => a.start - b.start || a.memberId.localeCompare(b.memberId)),
    droppedUnconfirmed,
  };
}

function placeAt(
  household: Household,
  slot: Slot,
  next: Slot | undefined,
  route: StoreRoute,
  duration: number,
):
  | {
      start: EpochMinutes;
      end: EpochMinutes;
      detour?: { plannedArrival: EpochMinutes; delayedArrival: EpochMinutes };
    }
  | undefined {
  const { store, walkFrom, walkTo } = route;
  if (slot.kind === 'commute') {
    const home = household.places.find((p) => p.id === slot.toId && p.kind === 'home');
    const homeWalk = home?.walkFromStationMin;
    const lastStation = slot.viaStationIds.at(-1);
    if (!home || homeWalk === undefined || lastStation === undefined) return undefined;
    if (home.nearStationId !== lastStation || store.nearStationId !== lastStation) return undefined;
    if (next?.kind !== 'home') return undefined;
    const atStation = slot.end - homeWalk;
    const start = atStation + walkFrom;
    const end = start + duration;
    const delayedArrival = slot.end + walkFrom + walkTo + duration;
    if (delayedArrival > next.end) return undefined;
    // 帰りが遅れる間、子を大人のいない家に残さない：他の大人が、その間ずっと家にいる時だけ寄る。
    if (!anotherAdultHome(household, slot, slot.end, delayedArrival)) return undefined;
    return { start, end, detour: { plannedArrival: slot.end, delayedArrival } };
  }
  if (slot.kind === 'away') {
    if (slot.placeId !== store.nearStationId) return undefined;
    const start = slot.start + walkFrom;
    const end = start + duration;
    if (end + walkTo > slot.end) return undefined;
    return { start, end };
  }
  return undefined;
}

function anotherAdultHome(
  household: Household,
  slot: Slot,
  from: EpochMinutes,
  until: EpochMinutes,
): boolean {
  return activeAdultIds(household)
    .filter((id) => id !== slot.memberId)
    .some((id) =>
      slotsOn(household, id, slot.date).some(
        (s) => s.kind === 'home' && s.start <= from && until <= s.end,
      ),
    );
}
