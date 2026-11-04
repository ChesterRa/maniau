// 家の最寄りの駅の近くで、品物を買う店を地図で探して選ぶ（デモ）。探す言葉は、Claude の案（推定）を家族が確かめて（要れば直して）
// 「探す」を押した時だけ、そのまま Google に送る。見つけた店の名前・住所は見せるだけで取っておかない。選んだ店は、
// place ID と家族の呼び名だけを家の情報に足す（見る → 保存。足した後の計画は、サーバーが同じ計算で見せる）。
import { formatDateTime, GOODS_KINDS, type Household, type Place } from '@maniau/core';
import { useState } from 'react';
import type { FoundStore, StoreSearchResult } from './family';
import { Attributions, GoogleMapsMark, TermsLink } from './maps';
import type { Ctx } from './screens';
import { Button, Label, Row, Text } from './ui';
import { Shown, useHouseholdSave } from './ways';

const input =
  'min-h-11 w-full rounded-xl border-[1.5px] border-btn-line bg-white px-2.5 text-base text-ink';
/** 探す言葉と呼び名の長さの上限（字。サーバーと同じ）。 */
const MAX_CHARS = 40;

/** 店を探す駅：家の最寄りの駅で、地図に結び付いた物（帰り道に寄る店は、この駅の近く）。無ければ探せない。 */
export function searchStation(household: Household): Place | undefined {
  const home = household.places.find((p) => p.kind === 'home');
  const station = household.places.find(
    (p) => p.kind === 'station' && p.id === home?.nearStationId,
  );
  return station?.googlePlaceId ? station : undefined;
}

/** 家族に見せる名前（人と場所）に重ならない呼び名（重なれば番号を付ける）。 */
function freeName(household: Household, label: string): string {
  const taken = new Set([...household.places, ...household.members].map((x) => x.name));
  let name = label;
  for (let n = 2; taken.has(name); n += 1) name = `${label} ${n}`;
  return name;
}

type Chosen =
  | {
      kind: 'new';
      store: FoundStore;
      /** 足す場所の ID（選んだ時に一度だけ作る。見た物と保存する物を同じにする）。 */
      id: string;
      label: string;
      /** place ID を調べた時刻（実際の時刻）。 */
      lookedUpAt: string;
    }
  /** もう家庭にある店（その店の扱う品物に、この品物を足す）。 */
  | { kind: 'known'; store: FoundStore; place: Place };

/** 家庭にもうある、同じ place ID の店。 */
const storeOf = (household: Household, found: FoundStore) =>
  household.places.find((p) => p.kind === 'store' && p.googlePlaceId === found.placeId);

/**
 * 選んだ店を、この品物を買う店にした家の情報（新しい店は足し、家庭にある店は扱う品物に足す）。前に選んだ店からは、
 * この品物を外す（「この店で買う」は選び直し。品物の名前は、ここで選んだ時だけ店の goods に入る）。
 */
function withStore(household: Household, what: string, stationId: string, c: Chosen): Household {
  const next = structuredClone(household);
  for (const place of next.places) {
    if (place.kind === 'store') place.goods = place.goods.filter((g) => g !== what);
  }
  if (c.kind === 'known') {
    const place = next.places.find((p) => p.id === c.place.id);
    if (place && !place.goods.includes(what)) place.goods.push(what);
    return next;
  }
  next.places.push({
    id: c.id,
    kind: 'store',
    name: c.label.trim(),
    nearStationId: stationId,
    googlePlaceId: c.store.placeId,
    lookedUpAt: c.lookedUpAt,
    goods: [what],
  });
  return next;
}

/**
 * 「ほかの店を探す」：開くと、探す言葉（はじめは品物の名前）を直せる。押せば、品物の名前だけを Claude に送って
 * 探す言葉の案をもらえる。家族が「探す」を押すと、駅から歩いて 15 分までの店を近い順に出す。「この店で買う」で、
 * この品物を買う店にすると何が変わるかを見て、保存する（家庭にある店も選べる）。地図の口の無いサーバーでは出さない。
 */
export function StoreSearch(props: { ctx: Ctx; what: string; first?: boolean }) {
  const { ctx, what } = props;
  const search = ctx.maps?.search;
  const kinds = ctx.maps?.kinds;
  // 地図の口の無い画面では、家の情報も読まない（出さない）。
  const station = search ? searchStation(ctx.household) : undefined;
  const flow = useHouseholdSave(ctx);
  const [open, setOpen] = useState(false);
  const [ideas, setIdeas] = useState<string[] | 'loading'>();
  const [query, setQuery] = useState(what);
  const [found, setFound] = useState<StoreSearchResult | 'searching'>();
  const [chosen, setChosen] = useState<Chosen>();

  if (!search || !station) return null;
  // 品物の名前が、店の扱う種類の名前と同じ字（kidsClothing など）なら、この品物のための店は選べない（店の goods では、
  // 品物のために選んだ店と、店の扱う種類を見分けられない。選んでも計算はその店にしないので、「この店で買う」と言わない）。
  if (GOODS_KINDS.has(what)) return <Text quiet>{ctx.t('stores.kindOnly', { what })}</Text>;

  // 案は、家族が押した時だけ聞く（送るのは品物の名前だけ）。直していなければ、最初の案を探す言葉に入れる。
  const ask = async () => {
    if (!kinds) return;
    setIdeas('loading');
    const queries = (await kinds(what)) ?? [];
    setIdeas(queries);
    const first = queries[0];
    if (first) setQuery((q) => (q === what ? first : q));
  };
  const run = async () => {
    const q = query.trim();
    if (!q) return;
    setChosen(undefined);
    setFound('searching');
    setFound(await search(q, station.id));
  };
  const choose = (store: FoundStore) => {
    const place = storeOf(ctx.household, store);
    const c: Chosen = place
      ? { kind: 'known', store, place }
      : {
          kind: 'new',
          store,
          id: `store-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`,
          label: freeName(ctx.household, query.trim()),
          lookedUpAt: formatDateTime(Math.floor(Date.now() / 60_000), ctx.household.timeZone),
        };
    setChosen(c);
    void flow.look(withStore(ctx.household, what, station.id, c));
  };
  const close = () => {
    setOpen(false);
    setChosen(undefined);
    setFound(undefined);
  };

  if (!open) {
    return (
      <Row>
        <Button kind="secondary" onClick={() => setOpen(true)}>
          {ctx.t(props.first ? 'stores.find' : 'stores.open')}
        </Button>
      </Row>
    );
  }

  const draft = chosen ? withStore(ctx.household, what, station.id, chosen) : undefined;
  const shown = draft ? flow.shownFor(draft) : undefined;
  const refused = draft ? flow.refusedFor(draft) : undefined;

  return (
    <div className="flex flex-col gap-2 rounded-xl bg-paper px-3 py-2.5">
      <Label tone="accent">{ctx.t('stores.label', { station: station.name })}</Label>
      {chosen && draft ? (
        <>
          <Text>
            <span translate="no">{chosen.store.name}</span>
            {ctx.t('stores.chosenWalk', { min: chosen.store.walkMin })}
          </Text>
          <Attributions ctx={ctx} list={chosen.store.attributions} />
          {chosen.kind === 'new' ? (
            <label className="flex flex-col gap-1">
              <span className="text-[15px] text-sub">{ctx.t('stores.nameLabel')}</span>
              <input
                className={input}
                value={chosen.label}
                maxLength={MAX_CHARS}
                onChange={(e) => setChosen({ ...chosen, label: e.target.value })}
              />
            </label>
          ) : (
            <Text quiet>{ctx.t('stores.addGoods', { name: chosen.place.name, what })}</Text>
          )}
          <Shown
            ctx={ctx}
            household={draft}
            {...(shown ? { preview: shown } : {})}
            {...(refused ? { refused } : {})}
          />
          <Row>
            {!shown && (
              <Button
                onClick={() => void flow.look(draft)}
                disabled={flow.busy || (chosen.kind === 'new' && chosen.label.trim() === '')}
              >
                {ctx.t('need.look')}
              </Button>
            )}
            {shown && (
              <Button
                onClick={() =>
                  void flow.save(draft).then((ok) => {
                    if (ok) close();
                  })
                }
                disabled={flow.busy}
              >
                {ctx.t('stores.save')}
              </Button>
            )}
            <Button kind="secondary" onClick={() => setChosen(undefined)} disabled={flow.busy}>
              {ctx.t('stores.back')}
            </Button>
          </Row>
        </>
      ) : (
        <>
          {kinds && ideas === undefined && (
            <div className="flex flex-col gap-1">
              <Row>
                <Button kind="secondary" onClick={() => void ask()}>
                  {ctx.t('stores.ask')}
                </Button>
              </Row>
              <Text quiet>{ctx.t('stores.askNote', { what })}</Text>
            </div>
          )}
          {ideas === 'loading' && <Text quiet>{ctx.t('stores.thinking')}</Text>}
          {Array.isArray(ideas) && ideas.length === 0 && (
            <Text quiet>{ctx.t('stores.noIdeas')}</Text>
          )}
          {Array.isArray(ideas) && ideas.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[15px] text-sub">{ctx.t('stores.ideas')}</span>
              <div className="flex flex-wrap gap-2">
                {ideas.map((idea) => (
                  <button
                    key={idea}
                    type="button"
                    aria-pressed={query === idea}
                    onClick={() => setQuery(idea)}
                    className={`min-h-11 rounded-xl border-[1.5px] px-3 font-bold ${query === idea ? 'border-accent bg-accent text-white' : 'border-btn-line bg-white'}`}
                  >
                    {idea}
                  </button>
                ))}
              </div>
            </div>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-[15px] text-sub">{ctx.t('stores.query')}</span>
            <input
              className={input}
              value={query}
              maxLength={MAX_CHARS}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <Text quiet>{ctx.t('stores.sendNote')}</Text>
          <Row>
            <Button
              onClick={() => void run()}
              disabled={found === 'searching' || query.trim() === ''}
            >
              {ctx.t('stores.search')}
            </Button>
            <Button kind="secondary" onClick={close}>
              {ctx.t('stores.close')}
            </Button>
          </Row>
          {found === 'searching' && <Text quiet>{ctx.t('stores.searching')}</Text>}
          {found !== undefined && found !== 'searching' && found.status !== 'ok' && (
            <Text>{ctx.t(`stores.${found.status}`)}</Text>
          )}
          {found !== undefined &&
            found !== 'searching' &&
            found.status === 'ok' &&
            (found.stores.length === 0 ? (
              <Text>{ctx.t('stores.none')}</Text>
            ) : (
              <>
                <ul className="flex flex-col gap-2">
                  {found.stores.map((s) => {
                    const mine = s.known ? storeOf(ctx.household, s) : undefined;
                    return (
                      <li
                        key={s.placeId}
                        className="flex flex-col gap-1 rounded-xl border border-line bg-white p-3"
                      >
                        <span className="font-bold" translate="no">
                          {s.name}
                        </span>
                        <span className="text-[15px]">
                          {ctx.t('stores.walk', { min: s.walkMin })}
                        </span>
                        {s.address && (
                          <span className="text-[13px] text-sub" translate="no">
                            {s.address}
                          </span>
                        )}
                        <Attributions ctx={ctx} list={s.attributions} />
                        {mine && <Text quiet>{ctx.t('stores.known', { name: mine.name })}</Text>}
                        {mine?.goods.includes(what) ? (
                          <Text quiet>{ctx.t('stores.already')}</Text>
                        ) : (
                          // 家庭の店でない場所（駅など）と place ID が同じ物は、店として選ばせない。
                          (!s.known || mine) && (
                            <Row>
                              <Button kind="secondary" onClick={() => choose(s)}>
                                {ctx.t('stores.choose')}
                              </Button>
                            </Row>
                          )
                        )}
                      </li>
                    );
                  })}
                </ul>
                <p className="text-[13px] text-sub">
                  {ctx.t('stores.source')} <GoogleMapsMark /> · <TermsLink ctx={ctx} />
                </p>
              </>
            ))}
        </>
      )}
    </div>
  );
}
