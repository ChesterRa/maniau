// 「うち」の「周りの資源」（02-foundation §3.5）：家族が入れた周りの資源（出典つき）と、一度だけ済ませておく前提
// （事前の登録など）の状態。家族が決める物（扱い・前提のだれの分・状態・有効な最後の日）だけを直せ、保存の前に「この
// 変更で変わること」を見せる。周りを調べた候補は、家族が入れると決めた物だけを家の情報に入れる（登録が要るかは
// Claude の読みとして見せ、家族が選ぶ）。種類（kind）で画面を分けない（種類の名前を出すだけ）。
import type {
  Household,
  Place,
  Preparation,
  Resource,
  ResourceSource,
  SurveyCandidate,
  SurveyShown,
} from '@maniau/core';
import { checkHomeArea, surveyPreparation } from '@maniau/core';
import { useState } from 'react';
import { type HomeCandidate, operationId, type SurveyPlace } from './family';
import { Attributions } from './maps';
import { StalePreview } from './need';
import { type Ctx, day, nameOf } from './screens';
import { Button, Card, Label, MoreLink, Row, Text, Title } from './ui';
import { Shown, useHouseholdSave } from './ways';

const USES = ['usual', 'candidate', 'notUsed'] as const;
const STATES = ['unknown', 'notDone', 'inProgress', 'done'] as const;
const input =
  'min-h-11 rounded-xl border-[1.5px] border-btn-line bg-white px-2.5 text-base text-ink';
const toggle = (on: boolean) =>
  `min-h-11 rounded-xl border-[1.5px] px-3 font-bold ${on ? 'border-accent bg-accent text-white' : 'border-btn-line bg-white'}`;

/**
 * 出典の一行：ウェブの頁（題・読んだ日・Claude が根拠に挙げた文が頁の本文にあったか。頁の文は出さない。公式かは
 * 言わない）、家族の言葉、デモの架空の決まり。
 */
function sourceLine(ctx: Ctx, source: ResourceSource): string {
  if (source.kind === 'demo') return ctx.t('resources.source.demo');
  if (source.kind === 'family') return ctx.t('resources.source.family');
  const title = source.title ?? source.url ?? '';
  const when = source.fetchedAt ? day(ctx, source.fetchedAt) : ctx.t('resources.source.noDate');
  return ctx.t(source.quoteFound ? 'resources.source.webQuoted' : 'resources.source.webUnchecked', {
    title,
    when,
  });
}

/** 出典の頁へのリンク（新しい窓で開く）。 */
export function SourceLink({ ctx, source }: { ctx: Ctx; source: ResourceSource }) {
  if (source.kind !== 'webPage' || !source.url) return null;
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      className="break-all text-accent-dark underline"
    >
      {ctx.t('resources.source.open')}
    </a>
  );
}

/**
 * 家の店の資源（家族の好み。02-foundation §3.5）：店の場所を指し、名前は店の名前、分かった事は無し。ID は店から
 * 決める（一つの店に一つ）。扱い（いつも使う・候補・使わない）は家族が選ぶ。
 */
export function storeResource(store: Place, use: Resource['use']): Resource {
  return {
    id: `res-store-${store.id}`,
    kind: 'store',
    name: store.name,
    placeId: store.id,
    notes: [],
    use,
  };
}

/** だれの分を家族が選ぶ（家族みんな・人ごと・分からない）。人を一人も選ばなければ分からない。 */
function AppliesChoice({
  ctx,
  household,
  value,
  onChange,
}: {
  ctx: Ctx;
  household: Household;
  value: Preparation['appliesTo'];
  onChange: (next: Preparation['appliesTo']) => void;
}) {
  const people = household.members.filter((m) => m.active && m.kind !== 'helper');
  const picked = value.kind === 'members' ? value.memberIds : [];
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sub">{ctx.t('resources.applies.choose')}</span>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          aria-pressed={value.kind === 'household'}
          className={toggle(value.kind === 'household')}
          onClick={() => onChange({ kind: 'household' })}
        >
          {ctx.t('resources.applies.choice.household')}
        </button>
        {people.map((m) => {
          const on = picked.includes(m.id);
          return (
            <button
              key={m.id}
              type="button"
              aria-pressed={on}
              className={toggle(on)}
              onClick={() => {
                const ids = on ? picked.filter((id) => id !== m.id) : [...picked, m.id];
                onChange(
                  ids.length === 0 ? { kind: 'unknown' } : { kind: 'members', memberIds: ids },
                );
              }}
            >
              {m.name}
            </button>
          );
        })}
        <button
          type="button"
          aria-pressed={value.kind === 'unknown'}
          className={toggle(value.kind === 'unknown')}
          onClick={() => onChange({ kind: 'unknown' })}
        >
          {ctx.t('resources.applies.choice.unknown')}
        </button>
      </div>
    </div>
  );
}

/** だれの前提か（家全体・その人たち・分からない）。 */
function appliesText(ctx: Ctx, household: Household, p: Preparation): string {
  if (p.appliesTo.kind === 'household') return ctx.t('resources.applies.household');
  if (p.appliesTo.kind === 'unknown') return ctx.t('resources.applies.unknown');
  return ctx.t('resources.applies.members', {
    names: p.appliesTo.memberIds
      .map((id) => nameOf(household, id))
      .join(ctx.t('resources.applies.joiner')),
  });
}

export function ResourcesCard({ ctx }: { ctx: Ctx }) {
  const [draft, setDraft] = useState<Household>();
  const [draftFrom, setDraftFrom] = useState<string>();
  // 調べた結果と、候補ごとの家族の選びは、直して保存した後も残す（後から登録を確かめに戻れるように。調べ直さない）。
  const [surveyShown, setSurveyShown] = useState<SurveyShown>();
  const [surveyChoices, setSurveyChoices] = useState<Record<string, CandidateChoice>>({});
  const flow = useHouseholdSave(ctx);
  const household = draft ?? ctx.household;
  const editing = draft !== undefined;
  const begin = (next: Household) => {
    setDraftFrom(JSON.stringify(ctx.household));
    setDraft(next);
  };
  const change = (update: (h: Household) => void) => {
    const next = structuredClone(household);
    update(next);
    setDraft(next);
  };
  const shown = draft ? flow.shownFor(draft) : undefined;
  const refused = draft ? flow.refusedFor(draft) : undefined;
  // 前の家の情報で作った下書きと、新しい記録で計算したプレビューを混ぜて保存しない。
  const stale =
    draft !== undefined &&
    (draftFrom !== JSON.stringify(ctx.household) ||
      (shown !== undefined && shown.throughSeq !== ctx.plan?.throughSeq));
  const save = async () => {
    if (draft && !stale && (await flow.save(draft))) {
      setDraft(undefined);
      setDraftFrom(undefined);
    }
  };
  const unattached = household.preparations.filter(
    (p) => !household.resources.some((r) => r.id === p.resourceId),
  );
  // 家の店のうち、店の資源（家族の扱い）がまだ無い店。
  const stores = household.places.filter(
    (p) => p.kind === 'store' && !household.resources.some((r) => r.placeId === p.id),
  );

  const preparationBlock = (p: Preparation) => {
    const ways = household.ways.filter((w) => w.requires?.includes(p.id));
    return (
      <div key={p.id} className="flex flex-col gap-1 rounded-xl bg-paper px-3 py-2.5">
        <p className="font-bold">{ctx.t('resources.preparation.title', { name: p.name })}</p>
        {!editing && (
          <Text>
            {ctx.t(`resources.preparation.state.${p.state}`)}
            {p.stateCheckedAt
              ? ctx.t('resources.preparation.checked', { when: day(ctx, p.stateCheckedAt) })
              : ''}
          </Text>
        )}
        {editing && (
          <div className="flex flex-wrap gap-1.5">
            {STATES.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={p.state === s}
                className={toggle(p.state === s)}
                onClick={() =>
                  change((h) => {
                    const target = h.preparations.find((x) => x.id === p.id);
                    if (target) target.state = s;
                  })
                }
              >
                {ctx.t(`resources.preparation.choice.${s}`)}
              </button>
            ))}
          </div>
        )}
        {editing ? (
          <AppliesChoice
            ctx={ctx}
            household={household}
            value={p.appliesTo}
            onChange={(next) =>
              change((h) => {
                const target = h.preparations.find((x) => x.id === p.id);
                if (target) target.appliesTo = next;
              })
            }
          />
        ) : (
          <Text quiet>{appliesText(ctx, household, p)}</Text>
        )}
        {p.source && <Text quiet>{sourceLine(ctx, p.source)}</Text>}
        {editing ? (
          <label className="flex flex-wrap items-center gap-2">
            <span className="text-sub">{ctx.t('resources.preparation.validUntil')}</span>
            <input
              type="date"
              className={input}
              value={p.validUntil ?? ''}
              onChange={(e) =>
                change((h) => {
                  const target = h.preparations.find((x) => x.id === p.id);
                  if (!target) return;
                  if (e.target.value) target.validUntil = e.target.value;
                  else delete target.validUntil;
                })
              }
            />
          </label>
        ) : (
          p.validUntil && (
            <Text quiet>
              {ctx.t('resources.preparation.validUntilText', { date: day(ctx, p.validUntil) })}
            </Text>
          )
        )}
        <Text quiet>
          {p.lead
            ? ctx.t('resources.preparation.lead', { days: p.lead.days })
            : ctx.t('resources.preparation.noLead')}
        </Text>
        {ways.length > 0 && (
          <Text quiet>
            {ctx.t('resources.preparation.ways', {
              ways: ways.map((w) => w.name).join(ctx.t('resources.applies.joiner')),
            })}
          </Text>
        )}
      </div>
    );
  };

  const resourceBlock = (r: Resource) => (
    <div key={r.id} className="flex flex-col gap-1.5 rounded-xl border border-line px-3 py-3">
      <Title>{r.name}</Title>
      {r.area && <Text quiet>{ctx.t('resources.area', { area: r.area })}</Text>}
      {!editing && <p className="font-bold">{ctx.t(`resources.use.${r.use}`)}</p>}
      {editing && (
        <div className="flex flex-wrap gap-1.5">
          {USES.map((u) => (
            <button
              key={u}
              type="button"
              aria-pressed={r.use === u}
              className={toggle(r.use === u)}
              onClick={() =>
                change((h) => {
                  const target = h.resources.find((x) => x.id === r.id);
                  if (target) target.use = u;
                })
              }
            >
              {ctx.t(`resources.use.choice.${u}`)}
            </button>
          ))}
        </div>
      )}
      {household.preparations.filter((p) => p.resourceId === r.id).map(preparationBlock)}
      {r.notes.map((note) => (
        <div key={`${note.text}-${note.source.url ?? note.source.kind}`} className="flex flex-col">
          <Text quiet>{note.text}</Text>
          <Text quiet>{sourceLine(ctx, note.source)}</Text>
          <SourceLink ctx={ctx} source={note.source} />
        </div>
      ))}
    </div>
  );

  return (
    <Card>
      <Label tone="sub">{ctx.t('resources.label')}</Label>
      {household.resources.length === 0 && unattached.length === 0 && (
        <Text quiet>{ctx.t('resources.none')}</Text>
      )}
      {household.resources.map(resourceBlock)}
      {/* 家の店で、まだ扱いを決めていない店：直す時に、家族が扱いを選ぶと、その店の資源を作る（一つの店に一つ）。 */}
      {editing &&
        stores.map((p) => (
          <div key={p.id} className="flex flex-col gap-1.5">
            <Title>{p.name}</Title>
            <Text quiet>{ctx.t('resources.stores.kind')}</Text>
            <div className="flex flex-wrap gap-1.5">
              {USES.map((u) => (
                <button
                  key={u}
                  type="button"
                  aria-pressed={false}
                  className={toggle(false)}
                  onClick={() => change((h) => h.resources.push(storeResource(p, u)))}
                >
                  {ctx.t(`resources.use.choice.${u}`)}
                </button>
              ))}
            </div>
          </div>
        ))}
      {unattached.map(preparationBlock)}
      {!editing && (household.resources.length > 0 || household.preparations.length > 0) && (
        <Row>
          <Button kind="secondary" onClick={() => begin(structuredClone(ctx.household))}>
            {ctx.t('resources.edit')}
          </Button>
        </Row>
      )}
      {!editing && stores.length > 0 && (
        <Text quiet>
          {ctx.t('resources.stores.hint', {
            names: stores.map((p) => p.name).join(ctx.t('list.separator')),
          })}
        </Text>
      )}
      <Text quiet>{ctx.t('resources.used')}</Text>
      <Text quiet>{ctx.t('resources.usedConfirm')}</Text>
      {!editing && ctx.home && <HomePanel ctx={ctx} home={ctx.home} />}
      {!editing && ctx.survey && (
        <SurveyPanel
          ctx={ctx}
          shown={surveyShown}
          onShown={setSurveyShown}
          choices={surveyChoices}
          onChoices={setSurveyChoices}
          onAdd={(next) => {
            begin(next);
            void flow.look(next);
          }}
        />
      )}
      {editing &&
        draft &&
        (stale ? (
          <StalePreview ctx={ctx} />
        ) : (
          <Shown ctx={ctx} preview={shown} refused={refused} household={draft} />
        ))}
      {editing && (household.resources.length > 0 || household.preparations.length > 0) && (
        <Row>
          {draft && !shown && !stale && (
            <Button
              onClick={() => void flow.look(draft)}
              disabled={flow.busy || !ctx.previewHousehold}
            >
              {ctx.t('household.look')}
            </Button>
          )}
          {shown && !stale && (
            <Button onClick={() => void save()} disabled={flow.busy}>
              {ctx.t('household.save')}
            </Button>
          )}
          <Button
            kind="secondary"
            onClick={() => {
              setDraft(undefined);
              setDraftFrom(undefined);
            }}
            disabled={flow.busy}
          >
            {ctx.t('household.cancel')}
          </Button>
        </Row>
      )}
    </Card>
  );
}

/**
 * 候補ごとに家族が選ぶ物：扱い、事前の登録（Claude の読みを確かめる。new：この頁の登録が要る。same：もう入れてある
 * 登録と同じ〔一度の登録で、ほかの施設も使える等〕。no・unsure：入れない）、だれの分、前提にするやり方、同じ名前の
 * 場所と同じ所か。
 */
interface CandidateChoice {
  use: Resource['use'];
  registration: 'new' | 'same' | 'no' | 'unsure';
  /** same の時の、もう入れてある登録。 */
  sameAs?: string;
  appliesTo: Preparation['appliesTo'];
  /** この登録を前提にするやり方（前提を足すだけ。使う資源・頼む先・行く所は替えない）。 */
  wayIds: string[];
  /** 家の情報に同じ名前の場所がある時、家族が「同じ所」と確かめたか（名前が同じだけでは同じ所と決めない）。 */
  samePlace?: true;
  /** 名前と住所を見て、家族が家の地図にも結ぶと選んだ場所。住所と徒歩は記録しない。 */
  mapPlaceId?: string;
}

const firstChoice: CandidateChoice = {
  use: 'candidate',
  registration: 'unsure',
  appliesTo: { kind: 'unknown' },
  wayIds: [],
};

/**
 * やり方の前提にする登録：家族が「要る」とした時はこの候補の登録、「同じ登録」とした時はその登録。「要らない」
 * 「まだ分からない」なら無い（Claude の読みによらない。「まだ分からない」のまま前提にしない）。
 */
function requiredOf(household: Household, candidate: SurveyCandidate, choice: CandidateChoice) {
  if (choice.registration === 'new') return surveyPreparation(candidate).id;
  if (
    choice.registration === 'same' &&
    household.preparations.some((p) => p.id === choice.sameAs)
  ) {
    return choice.sameAs;
  }
  return undefined;
}

/** 調べた候補の場所の ID（候補の ID から決まる）。 */
export const candidatePlaceId = (candidate: SurveyCandidate) =>
  `place-${candidate.id.replace(/^res-/, '')}`;

/** 家の情報にある、候補と同じ名前の場所（家は除く）。名前が同じでも、同じ所かは家族が確かめる。 */
const sameNamePlace = (household: Household, candidate: SurveyCandidate) =>
  household.places.find((p) => p.kind !== 'home' && p.name === candidate.resource.name);

/**
 * 候補の資源を結ぶ場所（やり方の手順は場所に頼む・行くので、資源を手順に結ぶ手がかり）：もう場所に結んだ資源なら、
 * その場所（替えない）。同じ名前の場所があれば、家族が「同じ所」と確かめた時だけその場所（確かめなければ場所に
 * 結ばない。前に確かめずに入れた資源も、後から確かめて結べる）。無ければ、まだ入れていない候補には、新しい場所
 * （施設。名前と地域だけ）。
 */
function placeFor(
  household: Household,
  candidate: SurveyCandidate,
  choice: CandidateChoice,
): { id: string; isNew: boolean } | undefined {
  const existing = household.resources.find((r) => r.id === candidate.id);
  if (existing?.placeId) return { id: existing.placeId, isNew: false };
  const same = sameNamePlace(household, candidate);
  if (same) return choice.samePlace ? { id: same.id, isNew: false } : undefined;
  return existing ? undefined : { id: candidatePlaceId(candidate), isNew: true };
}

/**
 * 候補を家の情報に入れた後の家（保存はしない。画面が「この変更で変わること」を見せる）。資源を場所に結んで入れ
 * （新しい場所なら足す）、家族が「要る」とした時だけ前提を入れる。選んだやり方は、その登録を前提に足すだけで、使う
 * 資源・頼む先・行く所は替えない（この所に頼むやり方は、やり方を写して作る：前の所の時間・費用・期限を、この所の事実に
 * しない）。もう入れた候補は、資源と前提を重ねて入れず、家族の扱いとだれの分を替えない。
 */
export function withCandidate(
  household: Household,
  candidate: SurveyCandidate,
  choice: CandidateChoice,
): Household {
  const next = structuredClone(household);
  const existing = next.resources.find((r) => r.id === candidate.id);
  if (existing) {
    // 前に場所に結ばずに入れた資源：家族が同じ名前の場所を「同じ所」と確かめた時だけ、その場所に結ぶ。
    const place = existing.placeId ? undefined : placeFor(household, candidate, choice);
    if (place) existing.placeId = place.id;
  } else {
    const place = placeFor(household, candidate, choice);
    if (place?.isNew) {
      const { area } = candidate.resource;
      next.places.push({
        id: place.id,
        kind: 'other',
        name: candidate.resource.name,
        ...(area ? { area } : {}),
        goods: [],
      });
    }
    next.resources.push({
      ...candidate.resource,
      ...(place ? { placeId: place.id } : {}),
      use: choice.use,
    });
  }
  // 住所を見て明示的に選んだ時だけ地図に結ぶ。別の場所へ結び済みなら、ここでは上書きしない。
  const linkedPlace = next.resources.find((r) => r.id === candidate.id)?.placeId;
  const linked = next.places.find((p) => p.id === linkedPlace);
  if (linked && choice.mapPlaceId && !linked.googlePlaceId) {
    linked.googlePlaceId = choice.mapPlaceId;
    delete linked.lookedUpAt;
  }
  const template = surveyPreparation(candidate);
  if (choice.registration === 'new' && !next.preparations.some((p) => p.id === template.id)) {
    next.preparations.push({ ...template, appliesTo: choice.appliesTo });
  }
  const required = requiredOf(next, candidate, choice);
  if (required === undefined) return next;
  for (const way of next.ways) {
    if (!choice.wayIds.includes(way.id)) continue;
    way.requires = [...(way.requires ?? []).filter((id) => id !== required), required];
  }
  return next;
}

/**
 * この所を使う新しいやり方の元にできる物：今のやり方のうち、候補と同じ種類の資源を使う物と、その資源（家族が、どの
 * やり方のどの資源の代わりかを選ぶ）。候補が場所に結んである時だけ（手順の頼む先・行く所に使えない時は出さない）。
 */
export function copyBases(
  household: Household,
  candidate: SurveyCandidate,
): { way: Household['ways'][number]; instead: Resource }[] {
  const placed = household.resources.find((r) => r.id === candidate.id)?.placeId;
  if (!placed) return [];
  return household.ways
    .filter((w) => !household.stoppedWayIds?.includes(w.id))
    .flatMap((way) =>
      (way.resourceIds ?? [])
        .map((id) => household.resources.find((r) => r.id === id))
        .filter(
          (r): r is Resource =>
            r !== undefined && r.id !== candidate.id && r.kind === candidate.resource.kind,
        )
        .map((instead) => ({ way, instead })),
    );
}

type HomeState =
  | 'idle'
  | 'working'
  | 'detail'
  | 'noArea'
  | 'limit'
  | 'stale'
  | 'failed'
  | 'notFound'
  | 'denied'
  | 'gone';

/** Google マップで、その place ID の場所を開く（中身は取らない。リンクだけ）。 */
const mapsLink = (query: string, placeId: string) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}&query_place_id=${encodeURIComponent(placeId)}`;

/**
 * 名前だけの試用の家の場所：地域の欄（都道府県・市区町村・町名。家に残し、周りを調べる時に Claude に送る）と、番地の
 * 欄（地域の欄と合わせて、地図の照会にだけ使う）。地図で見つけた所は、家族が「合っている」を押した時だけ入れる。入れた
 * 後は、欄を空にする（番地を画面に残さない）。
 */
function HomePanel({ ctx, home }: { ctx: Ctx; home: NonNullable<Ctx['home']> }) {
  const place = ctx.household.places.find((p) => p.kind === 'home');
  const [open, setOpen] = useState(false);
  const [area, setArea] = useState('');
  const [detail, setDetail] = useState('');
  const [state, setState] = useState<HomeState>('idle');
  const [candidate, setCandidate] = useState<HomeCandidate>();
  const editing = open || !place;
  const checked = area.trim() === '' ? undefined : checkHomeArea(area);
  const ready = checked !== undefined && typeof checked !== 'string';
  const set = async () => {
    if (!ready) return;
    setState('working');
    setCandidate(undefined);
    // 地図を使わないサーバーには、番地を送らない（番地の欄も出さない）。
    const asked = home.maps ? detail.trim() : '';
    const result = await home.set(area, asked);
    if (result.status !== 'ok') {
      setState(result.status);
      return;
    }
    setArea('');
    setDetail('');
    setOpen(false);
    // 住所の無い候補は、見分けられないので確かめに出さない（サーバーも出さない）。
    const shown = result.candidate?.address ? result.candidate : undefined;
    setCandidate(shown);
    setState(!shown && home.maps && asked !== '' ? 'notFound' : 'idle');
  };
  const confirm = async (yes: boolean) => {
    if (!candidate) return;
    if (!yes) {
      setCandidate(undefined);
      setState('denied');
      return;
    }
    setState('working');
    const done = await home.confirm(candidate.id);
    setCandidate(undefined);
    setState(done === 'ok' ? 'idle' : done);
  };
  const said = (
    ['detail', 'noArea', 'limit', 'stale', 'failed', 'notFound', 'denied', 'gone'] as const
  )
    .filter((s) => s === state)
    .map((s) => <Text key={s}>{ctx.t(`resources.home.${s}`)}</Text>);

  return (
    <div className="flex flex-col gap-2 rounded-xl bg-paper px-3 py-2.5">
      <Title>{ctx.t('resources.home.title')}</Title>
      {place?.area && !editing && (
        <>
          <Text>{ctx.t('resources.home.area', { area: place.area })}</Text>
          {place.googlePlaceId ? (
            <>
              <Text quiet>{ctx.t('resources.home.mapped')}</Text>
              <a
                className="text-sm text-accent underline"
                href={mapsLink(place.area, place.googlePlaceId)}
                target="_blank"
                rel="noreferrer"
              >
                {ctx.t('resources.home.mapLink')}
              </a>
            </>
          ) : (
            <Text quiet>{ctx.t('resources.home.notMapped')}</Text>
          )}
        </>
      )}
      {candidate && (
        <>
          <Text>{ctx.t('resources.home.candidate', { address: candidate.address })}</Text>
          <Text quiet>
            {ctx.t('resources.home.credit', {
              providers: ['Google', ...(candidate.attributions ?? []).map((a) => a.provider)].join(
                ctx.t('list.separator'),
              ),
            })}
          </Text>
          <Text quiet>{ctx.t('resources.home.confirmNote')}</Text>
          <Row>
            <Button onClick={() => void confirm(true)} disabled={state === 'working'}>
              {ctx.t('resources.home.yes')}
            </Button>
            <Button
              kind="secondary"
              onClick={() => void confirm(false)}
              disabled={state === 'working'}
            >
              {ctx.t('resources.home.no')}
            </Button>
          </Row>
        </>
      )}
      {said}
      {editing ? (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-sub">{ctx.t('resources.home.areaLabel')}</span>
            <input
              className={input}
              value={area}
              maxLength={60}
              autoComplete="off"
              placeholder={ctx.t('resources.home.areaPlaceholder')}
              onChange={(e) => setArea(e.target.value)}
            />
          </label>
          {home.maps && (
            <label className="flex flex-col gap-1">
              <span className="text-sub">{ctx.t('resources.home.detailLabel')}</span>
              <input
                className={input}
                value={detail}
                maxLength={60}
                autoComplete="off"
                placeholder={ctx.t('resources.home.detailPlaceholder')}
                onChange={(e) => setDetail(e.target.value)}
              />
            </label>
          )}
          {ready && <Text>{ctx.t('resources.home.sends', { area: checked.area })}</Text>}
          {checked === 'detail' && <Text>{ctx.t('resources.home.detail')}</Text>}
          {checked === 'noCity' && <Text>{ctx.t('resources.home.noArea')}</Text>}
          <Text quiet>{ctx.t('resources.home.noteArea')}</Text>
          <Text quiet>
            {ctx.t(home.maps ? 'resources.home.noteDetail' : 'resources.home.noteNoMaps')}
          </Text>
          <Text quiet>{ctx.t('resources.home.noteKeep')}</Text>
          <Row>
            <Button onClick={() => void set()} disabled={!ready || state === 'working'}>
              {ctx.t('resources.home.set')}
            </Button>
            {place && (
              <Button kind="secondary" onClick={() => setOpen(false)}>
                {ctx.t('resources.home.cancel')}
              </Button>
            )}
          </Row>
        </>
      ) : (
        <Row>
          <Button
            kind="secondary"
            onClick={() => {
              setOpen(true);
              setCandidate(undefined);
              setState('idle');
            }}
          >
            {ctx.t('resources.home.again')}
          </Button>
        </Row>
      )}
    </div>
  );
}

type PlacesState =
  | 'idle'
  | 'working'
  | 'shown'
  | 'none'
  | 'notSame'
  | 'limit'
  | 'failed'
  | 'noHome'
  | 'gone';

/**
 * 調べた候補を、確かめた家の場所の近くで地図に探す。名前で探すので、同じ名前の別の所（分院など）のこともある：家族が
 * 出典の頁の所在地と比べて同じ所を選んでから、家からの徒歩を見せる（選ぶ前は徒歩を出さない）。Google の名前・住所・
 * 徒歩は見せるだけで、残さない。
 */
function PlacesBlock({
  ctx,
  candidateId,
  find,
  canLink,
  mapPlaceId,
  onMapPlace,
}: {
  ctx: Ctx;
  candidateId: string;
  find: (candidateId: string) => ReturnType<NonNullable<NonNullable<Ctx['survey']>['places']>>;
  canLink: boolean;
  mapPlaceId: string | undefined;
  onMapPlace: (placeId: string | undefined) => void;
}) {
  const [state, setState] = useState<PlacesState>('idle');
  const [places, setPlaces] = useState<SurveyPlace[]>([]);
  const [picked, setPicked] = useState<SurveyPlace>();
  const look = async () => {
    setState('working');
    setPicked(undefined);
    onMapPlace(undefined);
    const result = await find(candidateId);
    if (result.status !== 'ok') {
      setState(result.status);
      return;
    }
    // 住所の無い所は、出典の所在地と比べようがないので選ばせない（サーバーも返さない）。
    const checkable = result.places.filter((p) => p.address);
    setPlaces(checkable);
    setState(checkable.length === 0 ? 'none' : 'shown');
  };
  const credit = (shown: SurveyPlace[]) => (
    <span className="flex flex-wrap items-center gap-1">
      <span className="inline-flex px-2.5 pt-2.5 pb-[5px]">
        <img
          src="/google-maps-attribution.svg"
          alt="Google Maps"
          translate="no"
          className="h-[18px] w-auto"
        />
      </span>
      <span>
        {ctx.t('resources.survey.places.credit', {
          providers: [
            'Google',
            ...new Set(shown.flatMap((p) => (p.attributions ?? []).map((a) => a.provider))),
          ].join(ctx.t('list.separator')),
        })}
      </span>
    </span>
  );
  return (
    <div className="flex flex-col gap-1.5">
      {(state === 'idle' || state === 'failed') && (
        <Row>
          <Button kind="secondary" onClick={() => void look()}>
            {ctx.t('resources.survey.places.look')}
          </Button>
        </Row>
      )}
      {state === 'working' && <Text>{ctx.t('resources.survey.places.working')}</Text>}
      {state === 'shown' && !picked && (
        <>
          <Text quiet>{ctx.t('resources.survey.places.pick')}</Text>
          {places.map((p) => (
            <div key={p.placeId} className="flex flex-col gap-1">
              <Text>
                {ctx.t('resources.survey.places.item', { name: p.name, address: p.address })}
              </Text>
              <Attributions ctx={ctx} list={p.attributions} name={p.name} />
              <Row>
                <Button kind="secondary" onClick={() => setPicked(p)}>
                  {ctx.t('resources.survey.places.same')}
                </Button>
              </Row>
            </div>
          ))}
          <Row>
            <Button kind="secondary" onClick={() => setState('notSame')}>
              {ctx.t('resources.survey.places.noneSame')}
            </Button>
          </Row>
          <Text quiet>{credit(places)}</Text>
        </>
      )}
      {state === 'shown' && picked && (
        <>
          <Text>
            {picked.walkMin === undefined
              ? ctx.t('resources.survey.places.noWalk', { name: picked.name })
              : ctx.t('resources.survey.places.walk', { min: picked.walkMin, name: picked.name })}
          </Text>
          <Text quiet>
            {ctx.t('resources.survey.places.picked', {
              name: picked.name,
              address: picked.address,
            })}
          </Text>
          <Text quiet>{credit([picked])}</Text>
          <Attributions ctx={ctx} list={picked.attributions} name={picked.name} />
          {canLink && (
            <>
              <button
                type="button"
                aria-pressed={mapPlaceId === picked.placeId}
                className={toggle(mapPlaceId === picked.placeId)}
                onClick={() =>
                  onMapPlace(mapPlaceId === picked.placeId ? undefined : picked.placeId)
                }
              >
                {ctx.t('resources.survey.places.linkMap')}
              </button>
              <Text quiet>{ctx.t('resources.survey.places.linkMapHint')}</Text>
            </>
          )}
        </>
      )}
      {state !== 'idle' && state !== 'working' && state !== 'shown' && (
        <Text>{ctx.t(`resources.survey.places.${state}`)}</Text>
      )}
      {/* 選び違えた時は、出した所から選び直す（地図に聞き直さない。何も残さない）。 */}
      {((state === 'shown' && picked) || state === 'notSame') && (
        <Row>
          <Button
            kind="secondary"
            onClick={() => {
              setPicked(undefined);
              onMapPlace(undefined);
              setState('shown');
            }}
          >
            {ctx.t('resources.survey.places.repick')}
          </Button>
        </Row>
      )}
    </div>
  );
}

type SurveyState = 'idle' | 'working' | 'limit' | 'busy' | 'noRecord' | 'noArea' | 'failed';

/**
 * 「周りを調べる」：記録した調べ（あれば）か、Claude がいま調べた結果の候補を、出典の頁・引用・Claude の読みと一緒に
 * 見せる。家族が候補ごとに扱い・登録・だれの分・使うやり方を選び、「この家の候補にする」で、保存の前の確かめに渡す。
 */
function SurveyPanel({
  ctx,
  shown,
  onShown: setShown,
  choices,
  onChoices: setChoices,
  onAdd,
}: {
  ctx: Ctx;
  shown: SurveyShown | undefined;
  onShown: (shown: SurveyShown) => void;
  choices: Record<string, CandidateChoice>;
  onChoices: (
    update: (all: Record<string, CandidateChoice>) => Record<string, CandidateChoice>,
  ) => void;
  onAdd: (next: Household) => void;
}) {
  const [state, setState] = useState<SurveyState>('idle');
  // 決める欄を開いている候補（一度に一つ）。入れた候補は、登録ややり方を確かめる時に開く。
  const [open, setOpen] = useState<string>();
  const survey = ctx.survey;
  if (!survey) return null;
  const run = async (live: boolean) => {
    setState('working');
    const result = await survey.run(live, operationId());
    if (result.status === 'ok') {
      setShown(result.survey);
      setState('idle');
    } else {
      setState(result.status);
    }
  };
  const household = ctx.household;
  // 家の場所を地図で確かめていれば、候補ごとに家からの徒歩を地図で調べられる。
  const homePlaced = household.places.some((p) => p.kind === 'home' && p.googlePlaceId);
  const ways = household.ways.filter((w) => !household.stoppedWayIds?.includes(w.id));
  const choiceOf = (id: string) => choices[id] ?? firstChoice;
  const choose = (id: string, update: Partial<CandidateChoice>) =>
    setChoices((all) => ({ ...all, [id]: { ...(all[id] ?? firstChoice), ...update } }));
  const reasons = (['notRead', 'quoteNotFound', 'copied', 'kind'] as const)
    .map((reason) => ({
      reason,
      count: shown?.dropped.filter((d) => d.reason === reason).length ?? 0,
    }))
    .filter((r) => r.count > 0)
    .map((r) => ctx.t(`resources.survey.reason.${r.reason}`, { count: r.count }))
    .join(ctx.t('resources.applies.joiner'));

  const candidateBlock = (c: SurveyCandidate) => {
    // もう家に入れた候補：入っていることと Claude の読みは見せ、登録とやり方の欄は必要な時に開く。
    const added = household.resources.some((r) => r.id === c.id);
    const note = c.resource.notes[0];
    const place = placeFor(household, c, choiceOf(c.id));
    const alreadyLinked =
      place && !place.isNew && household.places.find((p) => p.id === place.id)?.googlePlaceId;
    return (
      <div key={c.id} className="flex flex-col gap-1.5 rounded-xl bg-paper px-3 py-2.5">
        <Title>{c.resource.name}</Title>
        <Text quiet>
          {ctx.t(`resources.kind.${c.resource.kind}`, { defaultValue: c.resource.kind })}
          {c.resource.area ? ` ・ ${ctx.t('resources.area', { area: c.resource.area })}` : ''}
        </Text>
        {note && (
          <>
            <Text>{ctx.t('resources.survey.summary', { text: note.text })}</Text>
            <Text quiet>{sourceLine(ctx, note.source)}</Text>
            <SourceLink ctx={ctx} source={note.source} />
          </>
        )}
        {c.registration && (
          <Text>
            {ctx.t(
              c.registration.required
                ? 'resources.survey.registration.required'
                : 'resources.survey.registration.notRequired',
            )}
          </Text>
        )}
        {!c.registration && <Text quiet>{ctx.t('resources.survey.registration.notRead')}</Text>}
        {survey.places && homePlaced && (
          <PlacesBlock
            ctx={ctx}
            candidateId={c.id}
            find={survey.places}
            canLink={place !== undefined && !alreadyLinked}
            mapPlaceId={choiceOf(c.id).mapPlaceId}
            onMapPlace={(placeId) => choose(c.id, { mapPlaceId: placeId })}
          />
        )}
        {added ? (
          <>
            <Text quiet>{ctx.t('resources.survey.added')}</Text>
            <MoreLink
              expanded={open === c.id}
              onClick={() => setOpen(open === c.id ? undefined : c.id)}
            >
              {ctx.t('resources.survey.manage')}
            </MoreLink>
            {open === c.id && decideForm(c)}
          </>
        ) : open !== c.id ? (
          <Row>
            <Button kind="secondary" onClick={() => setOpen(c.id)}>
              {ctx.t('resources.survey.decide')}
            </Button>
          </Row>
        ) : (
          decideForm(c)
        )}
      </div>
    );
  };

  /** 候補を家に入れるかと、その扱い・事前の登録・前提にするやり方（家に入れた後は、登録と前提を後から確かめる）。 */
  const decideForm = (c: SurveyCandidate) => {
    const choice = choiceOf(c.id);
    const added = household.resources.some((r) => r.id === c.id);
    // 前提にできるのは、家族が登録を「要る」か「同じ登録」とした時だけ。同じ名前の場所は、家族が同じ所か確かめる。
    const linkable = requiredOf(household, c, choice) !== undefined;
    const same = sameNamePlace(household, c);
    // 入れた後：この所を使う新しいやり方の元（同じ種類の資源を使うやり方と、その資源）。
    const placed = household.resources.find((r) => r.id === c.id)?.placeId !== undefined;
    const bases = copyBases(household, c);
    return (
      <>
        {!added && (
          <>
            <span className="text-sub">{ctx.t('resources.survey.use')}</span>
            <div className="flex flex-wrap gap-1.5">
              {USES.map((u) => (
                <button
                  key={u}
                  type="button"
                  aria-pressed={choice.use === u}
                  className={toggle(choice.use === u)}
                  onClick={() => choose(c.id, { use: u })}
                >
                  {ctx.t(`resources.use.choice.${u}`)}
                </button>
              ))}
            </div>
          </>
        )}
        <span className="text-sub">{ctx.t('resources.survey.registration.choose')}</span>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            aria-pressed={choice.registration === 'new'}
            className={toggle(choice.registration === 'new')}
            onClick={() => choose(c.id, { registration: 'new' })}
          >
            {ctx.t('resources.survey.registration.choice.yes')}
          </button>
          {/* 同じ登録に選べるのは、ほかの資源の登録だけ（この候補の登録は「要る」）。 */}
          {household.preparations
            .filter((p) => p.resourceId !== c.id)
            .map((p) => {
              const on = choice.registration === 'same' && choice.sameAs === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={on}
                  className={toggle(on)}
                  onClick={() => choose(c.id, { registration: 'same', sameAs: p.id })}
                >
                  {ctx.t('resources.survey.registration.same', {
                    name: p.name,
                    state: ctx.t(`resources.preparation.state.${p.state}`),
                  })}
                </button>
              );
            })}
          {(['no', 'unsure'] as const).map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={choice.registration === r}
              className={toggle(choice.registration === r)}
              onClick={() => choose(c.id, { registration: r })}
            >
              {ctx.t(`resources.survey.registration.choice.${r}`)}
            </button>
          ))}
        </div>
        {choice.registration === 'new' && (
          <AppliesChoice
            ctx={ctx}
            household={household}
            value={choice.appliesTo}
            onChange={(next) => choose(c.id, { appliesTo: next })}
          />
        )}
        {!placed && same && (
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                aria-pressed={choice.samePlace === true}
                className={toggle(choice.samePlace === true)}
                onClick={() =>
                  setChoices((all) => {
                    const { samePlace, ...rest } = all[c.id] ?? firstChoice;
                    return { ...all, [c.id]: samePlace ? rest : { ...rest, samePlace: true } };
                  })
                }
              >
                {ctx.t('resources.survey.samePlace', { name: same.name })}
              </button>
            </div>
            {!choice.samePlace && <Text quiet>{ctx.t('resources.survey.samePlaceNot')}</Text>}
          </div>
        )}
        {ways.length > 0 && (
          <>
            <span className="text-sub">{ctx.t('resources.survey.ways')}</span>
            {!linkable && <Text quiet>{ctx.t('resources.survey.linkFirst')}</Text>}
            {ways.map((w) => {
              const on = choice.wayIds.includes(w.id);
              return (
                <label key={w.id} className="flex min-h-11 items-center gap-2">
                  <input
                    type="checkbox"
                    className="size-5"
                    checked={on}
                    disabled={!linkable}
                    onChange={() =>
                      choose(c.id, {
                        wayIds: on
                          ? choice.wayIds.filter((id) => id !== w.id)
                          : [...choice.wayIds, w.id],
                      })
                    }
                  />
                  <span>{w.name}</span>
                </label>
              );
            })}
          </>
        )}
        <Row>
          <Button onClick={() => onAdd(withCandidate(household, c, choice))}>
            {ctx.t(added ? 'resources.survey.update' : 'resources.survey.add')}
          </Button>
        </Row>
        {added && (
          <>
            <span className="text-sub">{ctx.t('resources.survey.copy.label')}</span>
            {bases.length > 0 && <Text quiet>{ctx.t('resources.survey.copy.note')}</Text>}
            {bases.map(({ way, instead }) => (
              <Row key={`${way.id}|${instead.id}`}>
                <Button
                  kind="secondary"
                  onClick={() =>
                    ctx.go({
                      name: 'way',
                      copy: { wayId: way.id, resourceId: c.id, insteadOf: instead.id },
                    })
                  }
                >
                  {ctx.t('resources.survey.copy.button', { way: way.name, old: instead.name })}
                </Button>
              </Row>
            ))}
            <Text quiet>
              {ctx.t(placed ? 'resources.survey.copy.other' : 'resources.survey.copy.noPlace')}
            </Text>
          </>
        )}
      </>
    );
  };

  // 名前だけの試用は、記録した調べ（見本の家族の地域の物）を使わず、家の場所を入れてから Claude にいま調べてもらう。
  const own = ctx.ownTrial === true;
  const homeArea = household.places.find((p) => p.kind === 'home')?.area;
  const canRun = !own || (homeArea !== undefined && survey.live);
  // 調べた後に家の場所を入れ直した時は、どの地域の結果かを言う（今の家の場所の結果と見せない）。
  const otherArea =
    shown !== undefined &&
    homeArea !== undefined &&
    shown.area !== homeArea &&
    !shown.area.startsWith(`${homeArea}（`);

  return (
    <div className="flex flex-col gap-2">
      <Text quiet>{ctx.t('resources.survey.intro')}</Text>
      {!shown && own && homeArea === undefined && (
        <Text>{ctx.t('resources.survey.ownNoArea')}</Text>
      )}
      {!shown && own && homeArea !== undefined && !survey.live && (
        <Text>{ctx.t('resources.survey.ownUnavailable')}</Text>
      )}
      {!shown && canRun && (
        <Row>
          <Button
            kind="secondary"
            onClick={() => void run(own || !survey.recorded)}
            disabled={state === 'working'}
          >
            {ctx.t('resources.survey.button')}
          </Button>
        </Row>
      )}
      {state === 'working' && <Text>{ctx.t('resources.survey.working')}</Text>}
      {state !== 'idle' && state !== 'working' && <Text>{ctx.t(`resources.survey.${state}`)}</Text>}
      {shown && (
        <>
          <Text>
            {ctx.t(shown.recorded ? 'resources.survey.recordedAt' : 'resources.survey.liveAt', {
              area: shown.area,
              when: day(ctx, shown.at),
            })}
          </Text>
          {otherArea && <Text>{ctx.t('resources.survey.otherArea', { area: homeArea })}</Text>}
          {/* 何が見つかったかを先に言い、要の限りは見せたまま、照らし方の細部はたたむ（開くと全文）。 */}
          <Text>
            {shown.candidates.length === 0
              ? ctx.t('resources.survey.none')
              : ctx.t('resources.survey.found', { count: shown.candidates.length })}
          </Text>
          <Text quiet>{ctx.t('resources.survey.checkedNote')}</Text>
          {own && survey.places && !homePlaced && shown.candidates.length > 0 && (
            <Text quiet>{ctx.t('resources.survey.places.hint')}</Text>
          )}
          <details className="text-sm text-sub">
            <summary className="min-h-9 cursor-pointer leading-relaxed">
              {ctx.t('resources.survey.checkedHowLabel')}
            </summary>
            <p className="mt-1 leading-relaxed">{ctx.t('resources.survey.checkedHow')}</p>
          </details>
          {shown.candidates.map(candidateBlock)}
          {reasons && (
            <Text quiet>
              {ctx.t('resources.survey.dropped', { count: shown.dropped.length, reasons })}
            </Text>
          )}
          {survey.live && (
            <Row>
              <Button
                kind="secondary"
                onClick={() => void run(true)}
                disabled={state === 'working'}
              >
                {ctx.t('resources.survey.again')}
              </Button>
            </Row>
          )}
        </>
      )}
    </div>
  );
}
