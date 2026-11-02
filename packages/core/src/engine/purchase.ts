// 買い物を、ふだんの週の中に置く（docs/design/01-model.md §5）。
// 帰り道の寄り道：通勤の区間の終わりが家で、店が家の最寄りの駅の近くにある時だけ。
//   駅に着く時刻 = 通勤の終わり − 家の駅からの徒歩。そこから店へ歩き、買って駅へ戻り、家へ歩く。
//   家に着くのが遅れる分は、続く家の区間（空いた時間）を短くする。次がお迎えなら寄らない。
//   遅れる間、他の大人が家にいる時だけ寄る。遅く帰ってよいかは、担当の人が引き受けて確かめる。
// 週末の外出：外出の区間の中で、その駅の近くの店へ行く。
// 移動の時間は、家庭の情報の目安（walkFromStationMin）で、地図で確かめていない。
import type { Household, Place } from '../schema/household';
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
}

function openDuring(store: Place, start: EpochMinutes, end: EpochMinutes, tz: string): boolean {
  if (!store.hours) return false;
  const date = localDateOf(start, tz);
  if (store.hours.closedDates.includes(date)) return false;
  const weekday = weekdayOf(date);
  return store.hours.periods.some(
    (p) =>
      p.weekday === weekday &&
      zonedToEpochMinutes(date, p.open, tz) <= start &&
      end <= zonedToEpochMinutes(date, p.close, tz),
  );
}

export function purchaseOpportunities(
  household: Household,
  goods: string,
  durationMin: number,
  from: EpochMinutes,
  until: EpochMinutes,
): PurchaseOpportunity[] {
  const tz = household.timeZone;
  const stores = household.places.filter((p) => p.kind === 'store' && p.goods.includes(goods));
  const result: PurchaseOpportunity[] = [];
  for (const memberId of activeAdultIds(household)) {
    const slots = slotsBetweenDates(
      household,
      memberId,
      localDateOf(from, tz),
      localDateOf(until, tz),
    );
    slots.forEach((slot, index) => {
      for (const store of stores) {
        const walk = store.walkFromStationMin;
        if (walk === undefined || store.nearStationId === undefined) continue;
        const option = placeAt(household, slot, slots[index + 1], store, walk, durationMin);
        if (!option) continue;
        const { start, end, detour } = option;
        if (start < from || end > until) continue;
        if (!openDuring(store, start, end, tz)) continue;
        result.push({
          memberId,
          storeId: store.id,
          start,
          end,
          travelBeforeMin: walk,
          travelAfterMin: walk,
          slotKind: slot.kind === 'commute' ? 'commute' : 'away',
          ...(detour ? { detour } : {}),
        });
      }
    });
  }
  return result.sort((a, b) => a.start - b.start || a.memberId.localeCompare(b.memberId));
}

function placeAt(
  household: Household,
  slot: Slot,
  next: Slot | undefined,
  store: Place,
  walk: number,
  duration: number,
):
  | {
      start: EpochMinutes;
      end: EpochMinutes;
      detour?: { plannedArrival: EpochMinutes; delayedArrival: EpochMinutes };
    }
  | undefined {
  if (slot.kind === 'commute') {
    const home = household.places.find((p) => p.id === slot.toId && p.kind === 'home');
    const homeWalk = home?.walkFromStationMin;
    const lastStation = slot.viaStationIds.at(-1);
    if (!home || homeWalk === undefined || lastStation === undefined) return undefined;
    if (home.nearStationId !== lastStation || store.nearStationId !== lastStation) return undefined;
    if (next?.kind !== 'home') return undefined;
    const atStation = slot.end - homeWalk;
    const start = atStation + walk;
    const end = start + duration;
    const delayedArrival = slot.end + 2 * walk + duration;
    if (delayedArrival > next.end) return undefined;
    // 帰りが遅れる間、子を大人のいない家に残さない：他の大人が、その間ずっと家にいる時だけ寄る。
    if (!anotherAdultHome(household, slot, slot.end, delayedArrival)) return undefined;
    return { start, end, detour: { plannedArrival: slot.end, delayedArrival } };
  }
  if (slot.kind === 'away') {
    if (slot.placeId !== store.nearStationId) return undefined;
    const start = slot.start + walk;
    const end = start + duration;
    if (end + walk > slot.end) return undefined;
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
