// 家族が地図に結んだ場所を、その要求の表示のためだけに引く。Google の位置・名前・住所は正本に残さない。
import type { Household, PlaceAttribution } from '@maniau/core';
import type { LatLng, MapsClient } from './google';

/** 一度の画面表示で照会する上限。残りは未設定とせず、数を添えて示す。 */
export const MAX_HOUSEHOLD_MAP_PLACES = 30;
/** 同じデモの地図での引き直しを減らす。位置の控えは短時間のメモリーだけ。 */
export const HOUSEHOLD_MAP_CACHE_MS = 15 * 60_000;
const MAX_CACHED_PLACES = 60;

export type HouseholdMapCache = Map<string, { expiresAt: number; location: LatLng }>;

export interface HouseholdMapPoint {
  /** 家族の場所 ID と、照会時の地図 ID（画面が古い位置を使わないため）。 */
  id: string;
  googlePlaceId: string;
  location: LatLng;
  attributions?: PlaceAttribution[];
}

export interface HouseholdMapView {
  points: HouseholdMapPoint[];
  /** 照会したが位置が得られなかった場所。 */
  failed: string[];
  /** 上限のため今回引かなかった場所。 */
  omitted: string[];
}

/** 場所の ID は必ずサーバーにある家庭の記録から取る。クライアントから地図 ID の配列は受けない。 */
export async function householdMap(
  household: Household,
  maps: MapsClient,
  cache: HouseholdMapCache,
  now: number,
): Promise<HouseholdMapView> {
  for (const [id, entry] of cache) if (entry.expiresAt <= now) cache.delete(id);
  const linked = household.places.filter((place) => place.googlePlaceId);
  const selected = linked.slice(0, MAX_HOUSEHOLD_MAP_PLACES);
  const results = await Promise.all(
    selected.map(async (place): Promise<HouseholdMapPoint | undefined> => {
      const googlePlaceId = place.googlePlaceId;
      if (!googlePlaceId) return undefined;
      try {
        const cached = cache.get(googlePlaceId);
        if (cached) return { id: place.id, googlePlaceId, location: cached.location };
        const result = await maps.place(googlePlaceId, { location: true });
        const location = result.location;
        if (
          !location ||
          !Number.isFinite(location.latitude) ||
          !Number.isFinite(location.longitude) ||
          Math.abs(location.latitude) > 90 ||
          Math.abs(location.longitude) > 180
        )
          return undefined;
        // 位置以外の Google の内容は控えない。提供者の表示が要る場所は毎回引き、一緒に返す。
        if (!result.attributions?.length) {
          if (cache.size >= MAX_CACHED_PLACES) {
            const oldest = cache.keys().next().value;
            if (oldest) cache.delete(oldest);
          }
          cache.set(googlePlaceId, { expiresAt: now + HOUSEHOLD_MAP_CACHE_MS, location });
        }
        return {
          id: place.id,
          googlePlaceId,
          location,
          ...(result.attributions ? { attributions: result.attributions } : {}),
        };
      } catch {
        return undefined;
      }
    }),
  );
  return {
    points: results.filter((point): point is HouseholdMapPoint => point !== undefined),
    failed: selected.flatMap((place, index) => (results[index] ? [] : [place.id])),
    omitted: linked.slice(MAX_HOUSEHOLD_MAP_PLACES).map((place) => place.id),
  };
}

/** 他の画面で場所や結び先が変われば、照会した古い位置をそのまま返さない。 */
export function sameMapPlaces(before: Household, after: Household): boolean {
  return (
    JSON.stringify(before.places.map((p) => [p.id, p.googlePlaceId ?? null])) ===
    JSON.stringify(after.places.map((p) => [p.id, p.googlePlaceId ?? null]))
  );
}
