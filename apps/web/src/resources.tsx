// 「うち」の「周りの資源」（02-foundation §3.5）：家族が入れた周りの資源（出典つき）と、一度だけ済ませておく前提
// （事前の登録など）の状態。家族が決める物（扱い・前提の状態・有効な最後の日）だけを直せ、保存の前に「この変更で
// 変わること」を見せる。調べた候補は、家族が入れるまで家の情報に入れない。種類（kind）で画面を分けない。
import type { Household, Preparation, Resource, ResourceSource } from '@maniau/core';
import { useState } from 'react';
import { type Ctx, day, nameOf } from './screens';
import { Button, Card, Label, Row, Text, Title } from './ui';
import { Shown, useHouseholdSave } from './ways';

const USES = ['usual', 'candidate', 'notUsed'] as const;
const STATES = ['unknown', 'notDone', 'inProgress', 'done'] as const;
const input =
  'min-h-11 rounded-xl border-[1.5px] border-btn-line bg-white px-2.5 text-base text-ink';
const toggle = (on: boolean) =>
  `min-h-11 rounded-xl border-[1.5px] px-3 font-bold ${on ? 'border-accent bg-accent text-white' : 'border-btn-line bg-white'}`;

/** 出典の一行：公式の頁（題・確かめた日・引用を頁で確かめたか）、家族の言葉、デモの架空の決まり。 */
function sourceLine(ctx: Ctx, source: ResourceSource): string {
  if (source.kind === 'demo') return ctx.t('resources.source.demo');
  if (source.kind === 'family') return ctx.t('resources.source.family');
  const title = source.title ?? source.url ?? '';
  const when = source.fetchedAt ? day(ctx, source.fetchedAt) : ctx.t('resources.source.noDate');
  return ctx.t(
    source.quoteFound ? 'resources.source.officialQuoted' : 'resources.source.officialUnchecked',
    { title, when },
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
  const flow = useHouseholdSave(ctx);
  const household = draft ?? ctx.household;
  const editing = draft !== undefined;
  const change = (update: (h: Household) => void) => {
    const next = structuredClone(household);
    update(next);
    setDraft(next);
  };
  const save = async () => {
    if (draft && (await flow.save(draft))) setDraft(undefined);
  };
  const shown = draft ? flow.shownFor(draft) : undefined;
  const refused = draft ? flow.refusedFor(draft) : undefined;
  const unattached = household.preparations.filter(
    (p) => !household.resources.some((r) => r.id === p.resourceId),
  );

  const preparationBlock = (p: Preparation) => {
    const ways = household.ways.filter((w) => w.requires?.includes(p.id));
    return (
      <div key={p.id} className="flex flex-col gap-1 rounded-xl bg-paper px-3 py-2.5">
        <Text>{ctx.t('resources.preparation.title', { name: p.name })}</Text>
        {p.source && <Text quiet>{sourceLine(ctx, p.source)}</Text>}
        {p.source?.quote && (
          <Text quiet>{ctx.t('resources.source.quote', { quote: p.source.quote })}</Text>
        )}
        <Text quiet>{appliesText(ctx, household, p)}</Text>
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
    <div key={r.id} className="flex flex-col gap-1.5">
      <Title>{r.name}</Title>
      {r.area && <Text quiet>{ctx.t('resources.area', { area: r.area })}</Text>}
      {r.notes.map((note) => (
        <div key={`${note.text}-${note.source.url ?? note.source.kind}`} className="flex flex-col">
          <Text>{note.text}</Text>
          <Text quiet>{sourceLine(ctx, note.source)}</Text>
          {note.source.quote && (
            <Text quiet>{ctx.t('resources.source.quote', { quote: note.source.quote })}</Text>
          )}
        </div>
      ))}
      {!editing && <Text>{ctx.t(`resources.use.${r.use}`)}</Text>}
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
    </div>
  );

  return (
    <Card>
      <Label tone="sub">{ctx.t('resources.label')}</Label>
      {household.resources.length === 0 && unattached.length === 0 && (
        <Text quiet>{ctx.t('resources.none')}</Text>
      )}
      {household.resources.map(resourceBlock)}
      {unattached.map(preparationBlock)}
      <Text quiet>{ctx.t('resources.used')}</Text>
      {editing && draft && <Shown ctx={ctx} preview={shown} refused={refused} household={draft} />}
      {(household.resources.length > 0 || household.preparations.length > 0) && (
        <Row>
          {!editing && (
            <Button kind="secondary" onClick={() => setDraft(structuredClone(ctx.household))}>
              {ctx.t('household.edit')}
            </Button>
          )}
          {editing && draft && !shown && (
            <Button
              onClick={() => void flow.look(draft)}
              disabled={flow.busy || !ctx.previewHousehold}
            >
              {ctx.t('household.look')}
            </Button>
          )}
          {editing && shown && (
            <Button onClick={() => void save()} disabled={flow.busy}>
              {ctx.t('household.save')}
            </Button>
          )}
          {editing && (
            <Button kind="secondary" onClick={() => setDraft(undefined)} disabled={flow.busy}>
              {ctx.t('household.cancel')}
            </Button>
          )}
        </Row>
      )}
    </Card>
  );
}
