// 家族が確かめた場所を地図で見る。場所の検索結果は見るだけで、家族が選んだ place ID だけを家の情報に入れる。
import { checkHomeArea, type Household, type PlaceKind } from '@maniau/core';
import { useMemo, useRef, useState } from 'react';
import { type HouseholdMapView, type HouseholdPlaceSearchResult, operationId } from './family';
import { Attributions, HouseholdMapCanvas, TermsLink } from './maps';
import { StalePreview } from './need';
import type { Ctx } from './screens';
import { Button, Card, Label, Row, Text, Title } from './ui';
import { Shown, useHouseholdSave } from './ways';

type Candidate = Extract<HouseholdPlaceSearchResult, { status: 'ok' }>['places'][number];
type Target = { kind: 'existing'; id: string; name: string } | { kind: 'new' };
type Draft = {
  household: Household;
  before: string;
  name: string;
  candidate?: Candidate;
  remove?: true;
};

const KINDS: PlaceKind[] = [
  'home',
  'school',
  'afterSchoolCare',
  'workplace',
  'station',
  'store',
  'helperHome',
  'other',
];
const field =
  'min-h-11 rounded-xl border-[1.5px] border-btn-line bg-white px-2.5 text-base text-ink';
const placeKey = (household: Household) =>
  JSON.stringify(household.places.map((p) => [p.id, p.googlePlaceId ?? null]));

export function HouseholdMapCard({ ctx }: { ctx: Ctx }) {
  const flow = useHouseholdSave(ctx);
  const [opened, setOpened] = useState(false);
  const [map, setMap] = useState<{ key: string; value: HouseholdMapView }>();
  const [mapError, setMapError] = useState<string>();
  const [mapBusy, setMapBusy] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [target, setTarget] = useState<Target>();
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<PlaceKind>('school');
  const [newArea, setNewArea] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Candidate[]>();
  const [searchError, setSearchError] = useState<string>();
  const [searchBusy, setSearchBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>();
  const [saveFailed, setSaveFailed] = useState(false);
  const mapElement = useRef<HTMLDivElement>(null);
  const ticket = useRef(0);
  const mapTicket = useRef(0);

  const key = placeKey(ctx.household);
  // 家の場所が変わった後に、前の場所の点を描かない。
  const current = opened && map?.key === key ? map.value : undefined;
  const points = useMemo(() => current?.points ?? [], [current]);
  const oldMap = opened && map !== undefined && map.key !== key;
  const preview = draft ? flow.shownFor(draft.household) : undefined;
  const refused = draft ? flow.refusedFor(draft.household) : undefined;
  const draftStale =
    draft !== undefined &&
    (draft.before !== JSON.stringify(ctx.household) ||
      (preview !== undefined && preview.throughSeq !== ctx.plan.throughSeq));
  const canSearch = ctx.maps?.searchHouseholdPlace !== undefined;
  const homeArea = newArea.trim() ? checkHomeArea(newArea) : undefined;
  const areaReady = homeArea !== undefined && typeof homeArea !== 'string';

  const loadMap = async () => {
    setOpened(true);
    setMapError(undefined);
    if (!ctx.maps?.householdMap) {
      return;
    }
    const mine = ++mapTicket.current;
    setMapBusy(true);
    const response = await ctx.maps.householdMap();
    if (mine !== mapTicket.current) return;
    setMapBusy(false);
    if (response.status === 'ok') setMap({ key, value: response.map });
    else setMapError(response.status);
  };
  const start = (next: Target) => {
    ticket.current++;
    setTarget(next);
    if (next.kind === 'new') {
      setNewName('');
      setNewKind('school');
      setNewArea('');
    }
    setQuery('');
    setResults(undefined);
    setSearchError(undefined);
    setSearchBusy(false);
    setDraft(undefined);
    setSaveFailed(false);
  };
  const stop = () => {
    ticket.current++;
    setTarget(undefined);
    setResults(undefined);
    setDraft(undefined);
    setSearchBusy(false);
  };
  const changed = (value: string) => {
    ticket.current++;
    setQuery(value);
    setResults(undefined);
    setDraft(undefined);
    setSearchError(undefined);
    setSearchBusy(false);
  };
  const search = async () => {
    if (!target || !ctx.maps?.searchHouseholdPlace || !query.trim()) return;
    if (target.kind === 'new' && (!newName.trim() || (newKind === 'home' && !areaReady))) return;
    const mine = ++ticket.current;
    setSearchBusy(true);
    setSearchError(undefined);
    setResults(undefined);
    const response = await ctx.maps.searchHouseholdPlace(
      target.kind === 'existing' ? target.id : undefined,
      query.trim(),
    );
    if (ticket.current !== mine) return;
    setSearchBusy(false);
    if (response.status === 'ok') setResults(response.places);
    else setSearchError(response.status);
  };
  const choose = (candidate: Candidate) => {
    if (!target) return;
    const next = structuredClone(ctx.household);
    let name: string;
    if (target.kind === 'existing') {
      const place = next.places.find((p) => p.id === target.id);
      if (!place) {
        setSearchError('gone');
        return;
      }
      name = place.name;
      place.googlePlaceId = candidate.placeId;
      // 前の場所を照会した時刻を、新しく結んだ場所に当てない。
      delete place.lookedUpAt;
    } else {
      name = newName.trim();
      if (!name) return;
      if (newKind === 'home' && next.places.some((p) => p.kind === 'home')) {
        setSearchError('homeExists');
        return;
      }
      next.places.push({
        id: `p-${operationId()}`,
        kind: newKind,
        name,
        ...(newKind === 'home' && areaReady ? { area: homeArea.area } : {}),
        googlePlaceId: candidate.placeId,
        goods: [],
      });
    }
    setSaveFailed(false);
    setDraft({ household: next, before: JSON.stringify(ctx.household), name, candidate });
  };
  const unlink = (id: string) => {
    const next = structuredClone(ctx.household);
    const place = next.places.find((p) => p.id === id);
    if (!place?.googlePlaceId) return;
    start({ kind: 'existing', id, name: place.name });
    delete place.googlePlaceId;
    delete place.lookedUpAt;
    setDraft({
      household: next,
      before: JSON.stringify(ctx.household),
      name: place.name,
      remove: true,
    });
  };
  const save = async () => {
    if (!draft || draftStale) return;
    if (await flow.save(draft.household)) stop();
    else setSaveFailed(true);
  };

  return (
    <Card>
      <Label tone="sub">{ctx.t('familyMap.label')}</Label>
      <Title>{ctx.t('familyMap.title')}</Title>
      <Text quiet>{ctx.t('familyMap.intro')}</Text>
      {!opened ? (
        <Button onClick={() => void loadMap()}>
          {ctx.t(ctx.maps?.householdMap ? 'familyMap.open' : 'familyMap.openList')}
        </Button>
      ) : (
        <>
          {mapBusy && <Text quiet>{ctx.t('familyMap.loading')}</Text>}
          {mapError && <Text>{ctx.t(`familyMap.error.${mapError}`)}</Text>}
          {mapError === 'stale' && ctx.refresh && (
            <Button kind="secondary" onClick={ctx.refresh}>
              {ctx.t('household.preview.refresh')}
            </Button>
          )}
          {oldMap && <Text>{ctx.t('familyMap.changed')}</Text>}
          {current && points.length === 0 && <Text>{ctx.t('familyMap.noPoints')}</Text>}
          {current && points.length > 0 && (
            <>
              <div ref={mapElement}>
                <HouseholdMapCanvas
                  ctx={ctx}
                  points={points}
                  selected={selected}
                  onSelect={setSelected}
                />
              </div>
              <Text quiet>{ctx.t('familyMap.mapHint')}</Text>
            </>
          )}
          <Row>
            <Button
              kind="secondary"
              onClick={() => void loadMap()}
              disabled={mapBusy || !ctx.maps?.householdMap}
            >
              {ctx.t('familyMap.reload')}
            </Button>
            <Button
              kind="secondary"
              onClick={() => {
                mapTicket.current++;
                setOpened(false);
                setMapBusy(false);
                setMap(undefined);
                stop();
              }}
            >
              {ctx.t('familyMap.close')}
            </Button>
          </Row>
        </>
      )}
      {!ctx.maps?.householdMap && <Text quiet>{ctx.t('familyMap.unavailable')}</Text>}
      {opened && (
        <>
          <Label tone="sub">{ctx.t('familyMap.places')}</Label>
          {ctx.household.places.length === 0 && <Text quiet>{ctx.t('familyMap.noPlaces')}</Text>}
          {ctx.household.places.map((place) => {
            const location = points.find((p) => p.id === place.id);
            const number = location ? points.findIndex((p) => p.id === place.id) + 1 : undefined;
            const state = !place.googlePlaceId
              ? 'unlocated'
              : current?.failed.includes(place.id)
                ? 'failed'
                : current?.omitted.includes(place.id)
                  ? 'omitted'
                  : location
                    ? 'mapped'
                    : 'linked';
            return (
              <div key={place.id} className="flex flex-col gap-1 rounded-xl bg-paper px-3 py-2.5">
                <span className="font-bold">
                  {number !== undefined && (
                    <span
                      aria-hidden="true"
                      className="mr-2 inline-grid size-6 place-items-center rounded-full bg-accent text-sm text-white"
                    >
                      {number}
                    </span>
                  )}
                  {place.name}
                </span>
                <span className="text-sm text-sub">{ctx.t(`familyMap.placeState.${state}`)}</span>
                {location && (
                  <Attributions ctx={ctx} list={location.attributions} name={place.name} />
                )}
                <div className="flex flex-wrap gap-2">
                  {location && (
                    <button
                      type="button"
                      aria-pressed={selected === place.id}
                      aria-label={ctx.t('familyMap.showPinNamed', { name: place.name })}
                      className="min-h-10 text-left font-bold text-accent underline"
                      onClick={() => {
                        setSelected(place.id);
                        mapElement.current?.scrollIntoView({ block: 'nearest' });
                      }}
                    >
                      {ctx.t('familyMap.showPin')}
                    </button>
                  )}
                  {canSearch && (
                    <button
                      type="button"
                      aria-label={ctx.t('familyMap.findPlaceNamed', { name: place.name })}
                      className="min-h-10 text-left font-bold text-accent underline"
                      onClick={() => start({ kind: 'existing', id: place.id, name: place.name })}
                    >
                      {ctx.t(place.googlePlaceId ? 'familyMap.changePlace' : 'familyMap.findPlace')}
                    </button>
                  )}
                  {place.googlePlaceId && ctx.previewHousehold && (
                    <button
                      type="button"
                      aria-label={ctx.t('familyMap.unlinkNamed', { name: place.name })}
                      className="min-h-10 text-left font-bold text-accent underline"
                      onClick={() => unlink(place.id)}
                    >
                      {ctx.t('familyMap.unlink')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {canSearch && !target && (
            <Button kind="secondary" onClick={() => start({ kind: 'new' })}>
              {ctx.t('familyMap.add')}
            </Button>
          )}
          {target && (
            <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
              <Label tone="accent">{ctx.t('familyMap.searchTitle')}</Label>
              {target.kind === 'existing' ? (
                <Text>{ctx.t('familyMap.forPlace', { name: target.name })}</Text>
              ) : (
                <>
                  <label className="flex flex-col gap-1">
                    <span>{ctx.t('familyMap.name')}</span>
                    <input
                      className={field}
                      value={newName}
                      onChange={(e) => {
                        setNewName(e.target.value);
                        setResults(undefined);
                        setDraft(undefined);
                        setSearchError(undefined);
                      }}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span>{ctx.t('familyMap.kind')}</span>
                    <select
                      className={field}
                      value={newKind}
                      onChange={(e) => {
                        setNewKind(e.target.value as PlaceKind);
                        setDraft(undefined);
                        setSearchError(undefined);
                      }}
                    >
                      {KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {ctx.t(`familyMap.kindName.${kind}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {newKind === 'home' && (
                    <label className="flex flex-col gap-1">
                      <span>{ctx.t('familyMap.homeArea')}</span>
                      <input
                        className={field}
                        value={newArea}
                        maxLength={60}
                        onChange={(e) => {
                          setNewArea(e.target.value);
                          setDraft(undefined);
                        }}
                      />
                      <span className="text-sm text-sub">{ctx.t('familyMap.homeAreaHint')}</span>
                    </label>
                  )}
                </>
              )}
              {!draft?.remove && (
                <>
                  <Text quiet>{ctx.t('familyMap.searchAbout')}</Text>
                  <label className="flex flex-col gap-1">
                    <span>{ctx.t('familyMap.query')}</span>
                    <input
                      className={field}
                      value={query}
                      onChange={(e) => changed(e.target.value)}
                      maxLength={200}
                    />
                  </label>
                  <Button
                    onClick={() => void search()}
                    disabled={
                      searchBusy ||
                      !query.trim() ||
                      (target.kind === 'new' &&
                        (!newName.trim() || (newKind === 'home' && !areaReady)))
                    }
                  >
                    {ctx.t(searchBusy ? 'familyMap.searching' : 'familyMap.search')}
                  </Button>
                  {searchError && <Text>{ctx.t(`familyMap.error.${searchError}`)}</Text>}
                  {searchError === 'stale' && ctx.refresh && (
                    <Button kind="secondary" onClick={ctx.refresh}>
                      {ctx.t('household.preview.refresh')}
                    </Button>
                  )}
                  {results && results.length === 0 && <Text>{ctx.t('familyMap.noResults')}</Text>}
                  {results && results.length > 0 && (
                    <>
                      <Text>{ctx.t('familyMap.choose')}</Text>
                      {results.map((candidate) => (
                        <div
                          key={candidate.placeId}
                          className="flex flex-col gap-1 rounded-xl bg-paper p-3"
                        >
                          <span className="font-bold">{candidate.name}</span>
                          <span className="text-sm">{candidate.address}</span>
                          <Attributions ctx={ctx} list={candidate.attributions} />
                          <button
                            type="button"
                            aria-label={ctx.t('familyMap.chooseNamed', {
                              name: candidate.name,
                              address: candidate.address,
                            })}
                            className="min-h-10 self-start text-left font-bold text-accent underline"
                            onClick={() => choose(candidate)}
                          >
                            {ctx.t('familyMap.chooseThis')}
                          </button>
                        </div>
                      ))}
                      <span className="flex items-center gap-2 text-sm text-sub">
                        <span className="inline-flex px-2.5 pt-2.5 pb-[5px]">
                          <img
                            src="/google-maps-attribution.svg"
                            alt="Google Maps"
                            translate="no"
                            className="h-[18px] w-auto"
                          />
                        </span>
                        <TermsLink ctx={ctx} />
                      </span>
                    </>
                  )}
                </>
              )}
              {draft && (
                <>
                  <Text>
                    {draft.remove
                      ? ctx.t('familyMap.confirmUnlink', { name: draft.name })
                      : ctx.t('familyMap.confirm', {
                          name: draft.name,
                          result: draft.candidate?.name ?? '',
                          address: draft.candidate?.address ?? '',
                        })}
                  </Text>
                  {draftStale ? (
                    <StalePreview ctx={ctx} />
                  ) : (
                    <>
                      <Shown
                        ctx={ctx}
                        preview={preview}
                        refused={refused}
                        household={draft.household}
                      />
                      {!preview ? (
                        <Button
                          onClick={() => void flow.look(draft.household)}
                          disabled={flow.busy || !ctx.previewHousehold}
                        >
                          {ctx.t('household.look')}
                        </Button>
                      ) : (
                        <Button onClick={() => void save()} disabled={flow.busy}>
                          {ctx.t('household.save')}
                        </Button>
                      )}
                    </>
                  )}
                  {saveFailed && <Text>{ctx.t('familyMap.saveFailed')}</Text>}
                </>
              )}
              <Button kind="secondary" onClick={stop} disabled={flow.busy}>
                {ctx.t('household.cancel')}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
