// Google Maps Platform（Places API (New)・Routes API）をサーバーから呼ぶ口。鍵はサーバーだけに置く
// （GOOGLE_MAPS_API_KEY。ブラウザには出さない）。応答はその要求の計算と表示に使うだけで、事象・DB・ログ・
// Claude の入力に入れない（Google の条件。保存してよいのは place ID だけ）。中身はログに書かない。

const PLACES = 'https://places.googleapis.com/v1';
const ROUTES = 'https://routes.googleapis.com';
const TIMEOUT_MS = 6000;
/** サーバー全体で、一分に呼ぶ数の上限（超えたら地図なしの目安に戻る）。 */
const PER_MINUTE = 240;

export interface LatLng {
  latitude: number;
  longitude: number;
}

/**
 * Google の営業の時点（day は 0 が日曜。current には現地の日付が付く）。0 の値は省かれることがある
 * （proto3 の既定値）ので、読む側で 0 とする。
 */
export interface GooglePoint {
  day?: number;
  hour?: number;
  minute?: number;
  date?: { year: number; month: number; day: number };
}
export interface GooglePeriod {
  open: GooglePoint;
  close?: GooglePoint;
}

export interface PlaceDetails {
  id: string;
  name?: string;
  location?: LatLng;
  googleMapsUri?: string;
  /** IANA の時区（例：Asia/Tokyo）。 */
  timeZone?: string;
  regular?: GooglePeriod[];
  current?: GooglePeriod[];
}

export interface WalkRoute {
  durationSec: number;
  distanceM: number;
  /** 符号化した折れ線（地図に道を描く）。 */
  polyline?: string;
  /** 歩行の注意（Google が返した物。そのまま見せる）。 */
  warnings: string[];
}

export interface FoundPlace {
  id: string;
  name: string;
  address?: string;
  location?: LatLng;
}

export interface MapsClient {
  /** 場所の詳細。hours で営業時間（ふだんと照会の日から数日）、summary で名前・位置・地図の URL。 */
  place(placeId: string, want: { hours?: boolean; summary?: boolean }): Promise<PlaceDetails>;
  /** 徒歩の所要（秒）。キーは `${出発の place ID}>${着く place ID}`。道の無い組は入らない。 */
  walkMatrix(origins: string[], destinations: string[]): Promise<Map<string, number>>;
  /** 徒歩の道（地図に描く折れ線と注意）。 */
  walkRoute(fromPlaceId: string, toPlaceId: string): Promise<WalkRoute | undefined>;
  /** 中心の近く（半径 m の内）で、検索語に合う場所。 */
  searchText(query: string, center: LatLng, radiusM: number, max: number): Promise<FoundPlace[]>;
}

export class MapsError extends Error {
  constructor(readonly reason: 'http' | 'timeout' | 'rateLimited' | 'invalid') {
    super(`maps: ${reason}`);
  }
}

/** 一分ごとの数（サーバー全体）。 */
function limiter(perMinute: number, clock: () => number) {
  let window = 0;
  let count = 0;
  return () => {
    const now = Math.floor(clock() / 60_000);
    if (now !== window) {
      window = now;
      count = 0;
    }
    count += 1;
    if (count > perMinute) throw new MapsError('rateLimited');
  };
}

export function googleMaps(
  key: string,
  options: { fetch?: typeof fetch; clock?: () => number; perMinute?: number } = {},
): MapsClient {
  const doFetch = options.fetch ?? fetch;
  const take = limiter(options.perMinute ?? PER_MINUTE, options.clock ?? Date.now);

  async function call(url: string, fieldMask: string, body?: unknown): Promise<unknown> {
    take();
    let response: Response;
    try {
      response = await doFetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': fieldMask,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new MapsError(
        error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'http',
      );
    }
    // 失敗の中身（Google の文言）は返さない・書かない。理由の種類だけ。
    if (!response.ok) throw new MapsError('http');
    return response.json();
  }

  return {
    async place(placeId, want) {
      const fields = [
        'id',
        ...(want.summary ? ['displayName', 'location', 'googleMapsUri'] : []),
        ...(want.hours
          ? ['timeZone', 'regularOpeningHours.periods', 'currentOpeningHours.periods']
          : []),
      ];
      const raw = (await call(
        `${PLACES}/places/${encodeURIComponent(placeId)}?languageCode=ja&regionCode=JP`,
        fields.join(','),
      )) as {
        id?: string;
        displayName?: { text?: string };
        location?: LatLng;
        googleMapsUri?: string;
        timeZone?: { id?: string };
        regularOpeningHours?: { periods?: GooglePeriod[] };
        currentOpeningHours?: { periods?: GooglePeriod[] };
      };
      if (raw.id !== placeId) throw new MapsError('invalid');
      return {
        id: placeId,
        ...(raw.displayName?.text ? { name: raw.displayName.text } : {}),
        ...(raw.location ? { location: raw.location } : {}),
        ...(raw.googleMapsUri ? { googleMapsUri: raw.googleMapsUri } : {}),
        ...(raw.timeZone?.id ? { timeZone: raw.timeZone.id } : {}),
        ...(raw.regularOpeningHours?.periods ? { regular: raw.regularOpeningHours.periods } : {}),
        ...(raw.currentOpeningHours?.periods ? { current: raw.currentOpeningHours.periods } : {}),
      };
    },

    async walkMatrix(origins, destinations) {
      const result = new Map<string, number>();
      if (origins.length === 0 || destinations.length === 0) return result;
      const raw = (await call(
        `${ROUTES}/distanceMatrix/v2:computeRouteMatrix`,
        'originIndex,destinationIndex,duration,condition',
        {
          origins: origins.map((placeId) => ({ waypoint: { placeId } })),
          destinations: destinations.map((placeId) => ({ waypoint: { placeId } })),
          travelMode: 'WALK',
        },
      )) as {
        originIndex?: number;
        destinationIndex?: number;
        duration?: string;
        condition?: string;
      }[];
      if (!Array.isArray(raw)) throw new MapsError('invalid');
      for (const element of raw) {
        // 0 の番号は省かれることがある（proto3 の既定値。Google の文書）。省かれたら 0 とする。
        const o = origins[element.originIndex ?? 0];
        const d = destinations[element.destinationIndex ?? 0];
        const seconds = seconds_(element.duration);
        if (o === undefined || d === undefined || seconds === undefined) continue;
        if (element.condition !== 'ROUTE_EXISTS') continue;
        result.set(`${o}>${d}`, seconds);
      }
      return result;
    },

    async walkRoute(fromPlaceId, toPlaceId) {
      const raw = (await call(
        `${ROUTES}/directions/v2:computeRoutes`,
        'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.warnings',
        {
          origin: { placeId: fromPlaceId },
          destination: { placeId: toPlaceId },
          travelMode: 'WALK',
          languageCode: 'ja',
          regionCode: 'JP',
        },
      )) as {
        routes?: {
          duration?: string;
          distanceMeters?: number;
          polyline?: { encodedPolyline?: string };
          warnings?: string[];
        }[];
      };
      const route = raw.routes?.[0];
      const durationSec = seconds_(route?.duration);
      if (!route || durationSec === undefined) return undefined;
      return {
        durationSec,
        distanceM: route.distanceMeters ?? 0,
        ...(route.polyline?.encodedPolyline ? { polyline: route.polyline.encodedPolyline } : {}),
        warnings: route.warnings ?? [],
      };
    },

    async searchText(query, center, radiusM, max) {
      const raw = (await call(
        `${PLACES}/places:searchText`,
        'places.id,places.displayName,places.formattedAddress,places.location',
        {
          textQuery: query,
          languageCode: 'ja',
          regionCode: 'JP',
          locationBias: { circle: { center, radius: radiusM } },
          pageSize: max,
        },
      )) as {
        places?: {
          id?: string;
          displayName?: { text?: string };
          formattedAddress?: string;
          location?: LatLng;
        }[];
      };
      return (raw.places ?? []).flatMap((p) =>
        p.id && p.displayName?.text
          ? [
              {
                id: p.id,
                name: p.displayName.text,
                ...(p.formattedAddress ? { address: p.formattedAddress } : {}),
                ...(p.location ? { location: p.location } : {}),
              },
            ]
          : [],
      );
    },
  };
}

/** "555s" → 555。読めなければ undefined。 */
function seconds_(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value);
  return match ? Number(match[1]) : undefined;
}
