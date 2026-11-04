// 店までの徒歩の道を、Google の地図に描く（デモ）。地図は Maps JavaScript API で、画面の鍵（Maps JavaScript
// API だけを許し、置き場所の URL に限った物）を使う。名前・位置・道はサーバーが Google から引いた物を描くだけで、
// 取っておかない。地図の帰属（ロゴと著作権）は地図が出す。地図の外に出す Google の名前と時間には「Google Maps」
// と添える（翻訳させない）。
import type { PlaceAttribution } from '@maniau/core';
import { Fragment, useEffect, useRef, useState } from 'react';
import type { WalkView } from './family';
import type { Ctx } from './screens';

/** 使う所だけの、Google の地図の型（型の包みを足さない）。 */
interface LatLngLiteral {
  lat: number;
  lng: number;
}
interface GoogleMapsApi {
  maps: {
    Map: new (
      element: HTMLElement,
      options: object,
    ) => { fitBounds(b: unknown, pad: number): void };
    Polyline: new (options: object) => unknown;
    LatLngBounds: new () => { extend(point: LatLngLiteral): void };
    geometry?: { encoding: { decodePath(path: string): unknown[] } };
    marker?: { AdvancedMarkerElement: new (options: object) => unknown };
  };
}

const CALLBACK = '__maniauMapsReady';
let loading: Promise<GoogleMapsApi> | undefined;
let authFailed = false;
/** 鍵が通らなかった時に、描いた地図の代わりに文を出す（Google は後から gm_authFailure を呼ぶ）。 */
const authListeners = new Set<() => void>();

/** 地図の台本を一度だけ読む（言葉は最初に読んだ時の物）。鍵が通らなければ、Google が gm_authFailure を呼ぶ。 */
function loadMaps(key: string, lang: string): Promise<GoogleMapsApi> {
  if (loading) return loading;
  const w = window as unknown as Record<string, unknown>;
  // もう読んである（同じページで別の札が先に読んだ等）なら、それを使う。
  const ready = w.google as GoogleMapsApi | undefined;
  if (ready?.maps?.Map) {
    loading = Promise.resolve(ready);
    return loading;
  }
  loading = new Promise<GoogleMapsApi>((resolve, reject) => {
    w[CALLBACK] = () => {
      const google = w.google as GoogleMapsApi | undefined;
      if (google?.maps) resolve(google);
      else reject(new Error('maps'));
    };
    w.gm_authFailure = () => {
      authFailed = true;
      for (const listener of authListeners) listener();
    };
    const script = document.createElement('script');
    const params = new URLSearchParams({
      key,
      v: 'weekly',
      libraries: 'geometry,marker',
      language: lang,
      region: 'JP',
      loading: 'async',
      callback: CALLBACK,
    });
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.async = true;
    script.onerror = () => {
      loading = undefined;
      reject(new Error('maps'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

const point = (l: { latitude: number; longitude: number }): LatLngLiteral => ({
  lat: l.latitude,
  lng: l.longitude,
});

/** Google の名前と時間に添える出典（訳さない）。 */
export function GoogleMapsMark() {
  return (
    <span translate="no" className="whitespace-nowrap">
      Google Maps
    </span>
  );
}

/** 利用規約とプライバシーの頁（Google マップの追加利用規約と Google のプライバシーポリシーへの案内を含む）。 */
/**
 * 結果と一緒に見せなければならない、データの提供者（Google の attributions）。その結果のすぐそばに置く。
 * name を渡すと、どの場所の提供者かを書く。URL は http・https の物だけ繋ぐ。無ければ何も出さない。
 */
export function Attributions(props: {
  ctx: Ctx;
  list: PlaceAttribution[] | undefined;
  name?: string;
}) {
  const { ctx, list } = props;
  if (!list || list.length === 0) return null;
  return (
    <span className="text-[13px] text-sub">
      {props.name ? ctx.t('maps.providerFor', { name: props.name }) : ctx.t('maps.provider')}
      {list.map((a, i) => (
        <Fragment key={`${a.provider}>${a.providerUri ?? ''}`}>
          {i > 0 && ctx.t('maps.and')}
          {a.providerUri && /^https?:\/\//i.test(a.providerUri) ? (
            <a
              href={a.providerUri}
              target="_blank"
              rel="noreferrer"
              translate="no"
              className="text-accent underline"
            >
              {a.provider}
            </a>
          ) : (
            <span translate="no">{a.provider}</span>
          )}
        </Fragment>
      ))}
    </span>
  );
}

export function TermsLink({ ctx }: { ctx: Ctx }) {
  return (
    <a
      href={ctx.lang === 'en' ? '/terms.html#en' : '/terms.html'}
      target="_blank"
      rel="noreferrer"
      className="whitespace-nowrap text-accent underline"
    >
      {ctx.t('maps.terms')}
    </a>
  );
}

/** 地図の箱（駅・店の印と、駅から店までの徒歩の道）。描けなければ、文だけ残す。 */
function MapCanvas({ ctx, walk }: { ctx: Ctx; walk: WalkView }) {
  const element = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [noRoute, setNoRoute] = useState(false);
  const key = ctx.maps?.key;
  useEffect(() => {
    if (!key || !element.current) return;
    let cancelled = false;
    const box = element.current;
    const onAuthFailure = () => setFailed(true);
    authListeners.add(onAuthFailure);
    loadMaps(key, ctx.lang)
      .then((google) => {
        if (cancelled || authFailed) {
          if (authFailed) setFailed(true);
          return;
        }
        const station = point(walk.station.location);
        const store = point(walk.store.location);
        const map = new google.maps.Map(box, {
          center: store,
          zoom: 16,
          mapId: 'DEMO_MAP_ID',
          disableDefaultUI: true,
          zoomControl: true,
          gestureHandling: 'cooperative',
        });
        const bounds = new google.maps.LatLngBounds();
        bounds.extend(station);
        bounds.extend(store);
        // 道の線は、Google の道を読めた時だけ描く（駅と店を結ぶ直線を、歩く道と見せない）。
        const path =
          walk.route.polyline && google.maps.geometry
            ? google.maps.geometry.encoding.decodePath(walk.route.polyline)
            : undefined;
        if (path && path.length > 1) {
          new google.maps.Polyline({
            map,
            path,
            strokeColor: '#1d4ed8',
            strokeOpacity: 0.85,
            strokeWeight: 5,
          });
        } else {
          setNoRoute(true);
        }
        const Marker = google.maps.marker?.AdvancedMarkerElement;
        if (Marker) {
          new Marker({ map, position: station, title: walk.station.name ?? '' });
          new Marker({ map, position: store, title: walk.store.name ?? '' });
        }
        map.fitBounds(bounds, 48);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      authListeners.delete(onAuthFailure);
    };
  }, [key, ctx.lang, walk]);
  if (failed) return <p className="text-[15px] text-sub">{ctx.t('maps.failed')}</p>;
  return (
    <>
      <div
        ref={element}
        role="img"
        aria-label={ctx.t('maps.alt', {
          station: walk.station.name ?? '',
          store: walk.store.name ?? '',
        })}
        className="h-64 w-full overflow-hidden rounded-xl bg-paper"
      />
      {noRoute && <p className="text-[15px] text-sub">{ctx.t('maps.noRoute')}</p>}
    </>
  );
}

/**
 * 「地図で見る」を押した時に、店までの徒歩の道を読んで描く。地図の口の無い画面では出さない。
 * 名前・道・時間は Google の物と示し、Google マップで開く連絡も添える。
 */
export function WalkMap({ ctx, storeId }: { ctx: Ctx; storeId: string }) {
  const [open, setOpen] = useState(false);
  const [walk, setWalk] = useState<WalkView | 'loading' | 'failed'>();
  // 地図は画面の鍵がある時だけ描く（鍵が無ければ、地図の口があっても開く手を出さない）。
  const read = ctx.maps?.key ? ctx.maps.walk : undefined;
  useEffect(() => {
    if (!open || !read) return;
    let cancelled = false;
    setWalk('loading');
    void read(storeId).then((result) => {
      if (!cancelled) setWalk(result ?? 'failed');
    });
    return () => {
      cancelled = true;
    };
  }, [open, read, storeId]);
  if (!read) return null;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="self-start rounded-lg border border-line px-3 py-1.5 text-[15px] font-bold"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {ctx.t(open ? 'maps.hide' : 'maps.show')}
      </button>
      {open && walk === 'loading' && (
        <p className="text-[15px] text-sub">{ctx.t('maps.loading')}</p>
      )}
      {open && walk === 'failed' && <p className="text-[15px] text-sub">{ctx.t('maps.failed')}</p>}
      {open && walk && typeof walk === 'object' && (
        <div className="flex flex-col gap-1.5">
          <MapCanvas ctx={ctx} walk={walk} />
          <p className="text-[15px]">
            {/* 分は書かない（計画が使った分は札の上にある。別の照会の分を並べて、どちらが根拠か迷わせない）。 */}
            {ctx.t('maps.route', {
              station: walk.station.name ?? '',
              store: walk.store.name ?? '',
              km: (walk.route.distanceM / 1000).toFixed(1),
            })}
          </p>
          <Attributions
            ctx={ctx}
            list={walk.station.attributions}
            {...(walk.station.name ? { name: walk.station.name } : {})}
          />
          <Attributions
            ctx={ctx}
            list={walk.store.attributions}
            {...(walk.store.name ? { name: walk.store.name } : {})}
          />
          {walk.route.warnings.map((warning) => (
            <p key={warning} className="text-[15px] text-warn">
              {warning}
            </p>
          ))}
          {/* 歩く道の注意は、いつも添える（Google の注意が返れば、その上に並べる）。 */}
          <p className="text-[15px] text-sub">{ctx.t('maps.caution')}</p>
          <p className="text-[13px] text-sub">
            {ctx.t('maps.source')} <GoogleMapsMark /> · <TermsLink ctx={ctx} />
          </p>
          {walk.store.googleMapsUri && (
            <a
              href={walk.store.googleMapsUri}
              target="_blank"
              rel="noreferrer"
              className="self-start text-[15px] text-accent underline"
            >
              {ctx.t('maps.open')}
            </a>
          )}
        </div>
      )}
    </div>
  );
}
