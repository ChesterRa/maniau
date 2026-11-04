import type { Household, Place, PlanResult, StoreMapEvidence } from '@maniau/core';

/** 家庭の店・駅と、今回の計算に渡された地図の根拠を別々に照らす。 */
export function storeMapEvidence(
  household: Household,
  plan: PlanResult,
  store: Place,
): StoreMapEvidence | undefined {
  if (store.kind !== 'store' || !store.googlePlaceId || !store.nearStationId) return undefined;
  const station = household.places.find((place) => place.id === store.nearStationId);
  if (station?.kind !== 'station' || !station.googlePlaceId) return undefined;
  const candidates = plan.mapInputs?.stores.filter((entry) => entry.storeId === store.id) ?? [];
  if (candidates.length !== 1) return undefined;
  const evidence = candidates[0];
  return evidence?.googlePlaceId === store.googlePlaceId &&
    evidence.stationId === station.id &&
    evidence.stationGooglePlaceId === station.googlePlaceId
    ? evidence
    : undefined;
}
