// 駅の近くで、品物を買えそうな本物の店を探す（家族が押した時だけ）。検索語は家族が確かめた（要れば直した）物を、そのまま
// Google に送る（家族の名前・予定・お知らせの文は送らない）。結果は返すだけで、取っておかない。
import type { Household, PlaceAttribution } from '@maniau/core';
import type { LatLng, MapsClient } from './google';

/** 駅から歩いて寄る店として出す、片道の上限（分）。 */
const MAX_WALK_MIN = 15;
/** Google に頼む候補の数と、返す数。 */
const ASK = 8;
const SHOW = 5;
/** 駅の近くとみなす半径（m。Google には寄せるだけで、絞るのは歩く分）。 */
const NEAR_M = 800;

export interface FoundStore {
  /** Google の place ID（家族が選べば、これだけを家庭に残す）。 */
  placeId: string;
  /** Google での名前・住所・位置（見せるだけ）。 */
  name: string;
  /** 名前・住所と一緒に見せなければならない、データの提供者。 */
  attributions?: PlaceAttribution[];
  address?: string;
  location?: LatLng;
  /** 駅からの徒歩（分、切り上げ）。 */
  walkMin: number;
  /** 家庭にもう同じ店がある。 */
  known?: true;
}

/**
 * 家庭の駅（place ID のある物）の近くで、検索語に合う店を探し、駅から歩いて MAX_WALK_MIN 分までの物を近い順に
 * 返す。駅が地図に結び付かなければ undefined。道が引けない候補は出さない。失敗は投げる（呼ぶ側が伝える）。
 */
export async function searchStores(
  household: Household,
  client: MapsClient,
  query: string,
  stationId: string,
): Promise<FoundStore[] | undefined> {
  const station = household.places.find((p) => p.id === stationId && p.kind === 'station');
  if (!station?.googlePlaceId) return undefined;
  const at = await client.place(station.googlePlaceId, { summary: true });
  if (!at.location) return undefined;
  const found = (await client.searchText(query, at.location, NEAR_M, ASK)).filter(
    (f) => f.id !== station.googlePlaceId,
  );
  if (found.length === 0) return [];
  const walk = await client.walkMatrix(
    [station.googlePlaceId],
    found.map((f) => f.id),
  );
  const known = new Set(
    household.places.flatMap((p) => (p.googlePlaceId ? [p.googlePlaceId] : [])),
  );
  return found
    .flatMap((f): FoundStore[] => {
      const seconds = walk.get(`${station.googlePlaceId}>${f.id}`);
      if (seconds === undefined) return [];
      const walkMin = Math.ceil(seconds / 60);
      if (walkMin > MAX_WALK_MIN) return [];
      return [
        {
          placeId: f.id,
          name: f.name,
          ...(f.attributions ? { attributions: f.attributions } : {}),
          ...(f.address ? { address: f.address } : {}),
          ...(f.location ? { location: f.location } : {}),
          walkMin,
          ...(known.has(f.id) ? { known: true as const } : {}),
        },
      ];
    })
    .sort((a, b) => a.walkMin - b.walkMin)
    .slice(0, SHOW);
}
