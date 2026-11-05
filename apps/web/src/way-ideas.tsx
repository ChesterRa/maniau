// 「すること」に、Claude がやり方の案を出す画面（W4。02-foundation §3.4）。案は推定で、何も書かない：家族が案を
// 選んで表に写し、直して、変わることを見てから保存する（W1 と同じ道）。送る物は、押す前にサーバーと同じ関数で作って
// 見せる。外の事実（値段・相手の返事の早さ・締切の決まり・受け持てる時間）は Claude の案に無く、家族が表で入れる。
import {
  type CheckedDraft,
  type CheckedIdeas,
  WAY_IDEAS_LIMITS,
  type WayIdeaNote,
  type WayIdeasContext,
  wayIdeasContext,
} from '@maniau/core';
import { useRef, useState } from 'react';
import { operationId, type WayIdeasResult } from './family';
import { type Ctx, Missing, nameOf, needItem, needWhen } from './screens';
import { Button, Card, Header, Label, Main, MoreLink, Row, Text } from './ui';

/** 出した案と、送った物（「すること」ごと。画面のメモリだけに置き、サーバーには残らない）。 */
interface Shown {
  ideas: CheckedIdeas;
  sent: WayIdeasContext;
}
const shownIdeas = new Map<string, Shown>();
const cacheKey = (ctx: Ctx, arrangementKey: string) =>
  `${ctx.household.id}|${ctx.me.id}|${arrangementKey}`;

/** 今の材料で、送る物を作る（サーバーと同じ関数。手配が生きていなければ無し）。 */
function contextNow(
  ctx: Ctx,
  arrangementKey: string,
  words: string | undefined,
): WayIdeasContext | undefined {
  return wayIdeasContext(
    {
      plan: ctx.plan,
      items: ctx.items.map((l) => l.item),
      household: ctx.household,
      sources: [...ctx.sources.values()],
    },
    arrangementKey,
    words,
    ctx.lang,
    ctx.me.id,
  );
}

/**
 * 出した時と、今の「すること」の中身・言葉が同じか（違えば、前の中身で出した案なので表に写さない）。家の情報が
 * 増えた（やり方を足した等）だけでは古くしない：案の ID は消えない物だけで、保存の前にサーバーがもう一度確かめる。
 */
function current(ctx: Ctx, arrangementKey: string, shown: Shown): boolean {
  const now = contextNow(ctx, arrangementKey, shown.sent.familyWords ?? undefined);
  return (
    now !== undefined &&
    now.language === shown.sent.language &&
    JSON.stringify(now.need) === JSON.stringify(shown.sent.need)
  );
}

/** 表に写す案（出した時と「すること」が同じ時だけ）。 */
export function ideaDraft(
  ctx: Ctx,
  arrangementKey: string,
  index: number,
): CheckedDraft | undefined {
  const shown = shownIdeas.get(cacheKey(ctx, arrangementKey));
  if (!shown || !current(ctx, arrangementKey, shown)) return undefined;
  return shown.ideas.drafts[index];
}

/** 試験のため：画面のメモリの案を消す。 */
export function forgetIdeas(): void {
  shownIdeas.clear();
}

/** コードが案から外した・直した理由を、家族の言葉にする。 */
export function noteText(ctx: Ctx, note: WayIdeaNote): string {
  switch (note.code) {
    case 'noSteps':
      return ctx.t('wayIdeas.note.noSteps');
    case 'outOfRange':
      return ctx.t('wayIdeas.note.outOfRange', { value: note.value });
    default:
      return ctx.t(`wayIdeas.note.${note.code}`, { value: note.value });
  }
}

type State = 'idle' | 'working' | Exclude<WayIdeasResult['status'], 'ok'>;

/** 押す前に作った操作 ID を、同じ中身の送り直し（結果が分からない・混んでいる・上限）にだけ使う。 */
const renewable = (status: State) =>
  status === 'stale' || status === 'lost' || status === 'failed' || status === 'needGone';

export function WayIdeasScreen({ ctx, arrangementKey }: { ctx: Ctx; arrangementKey: string }) {
  const key = cacheKey(ctx, arrangementKey);
  const [shown, setShown] = useState<Shown | undefined>(() => shownIdeas.get(key));
  const [words, setWords] = useState(shown?.sent.familyWords ?? '');
  const [state, setState] = useState<State>('idle');
  const operation = useRef<{ id: string; digest: string }>(undefined);
  const arrangement = ctx.plan.arrangements.find(
    (a) => a.key === arrangementKey && a.kind === 'need' && a.live,
  );
  const back = () => ctx.go({ name: 'need', key: arrangementKey });
  if (!arrangement) return <Missing ctx={ctx} />;
  const item = needItem(ctx, arrangement);
  const requirement = ctx.plan.requirements.find((r) => r.key === arrangement.requirementKey);
  const text = words.trim();
  const context = contextNow(ctx, arrangementKey, text);
  const fresh = shown !== undefined && current(ctx, arrangementKey, shown);

  const ask = async () => {
    if (!ctx.wayIdeas || !context || state === 'working') return;
    const digest = JSON.stringify([arrangementKey, text, ctx.lang]);
    if (operation.current?.digest !== digest) operation.current = { id: operationId(), digest };
    setState('working');
    const result = await ctx.wayIdeas({
      arrangementKey,
      ...(text === '' ? {} : { text }),
      language: ctx.lang,
      operationId: operation.current.id,
    });
    if (result.status === 'ok') {
      const next = { ideas: result.ideas, sent: result.sent };
      shownIdeas.set(key, next);
      setShown(next);
      // 次に押すのは、新しく考えてもらう時（同じ ID は送り直しだけに使う）。
      operation.current = undefined;
      setState('idle');
      return;
    }
    if (renewable(result.status)) operation.current = undefined;
    setState(result.status);
  };

  return (
    <>
      <Header
        back={{ label: ctx.t('way.backToNeed'), onClick: back }}
        eyebrow={needWhen(ctx, arrangement, item)}
        title={ctx.t('wayIdeas.title')}
      />
      <Main>
        <Card>
          <Label tone="sub">{ctx.t('need.label')}</Label>
          <Text>{requirement?.what ?? ''}</Text>
          <Text quiet>{needWhen(ctx, arrangement, item)}</Text>
        </Card>
        <Text quiet>{ctx.t('wayIdeas.intro')}</Text>
        <Text quiet>{ctx.t('wayIdeas.outside')}</Text>
        {!ctx.wayIdeas ? (
          <Card tone="warn">
            <Text>{ctx.t('wayIdeas.unavailable')}</Text>
          </Card>
        ) : (
          <Card>
            <label className="flex flex-col gap-1">
              <span className="font-bold">{ctx.t('wayIdeas.words')}</span>
              <textarea
                className="min-h-20 rounded-xl border-[1.5px] border-btn-line bg-white px-2.5 py-2 text-base text-ink"
                maxLength={WAY_IDEAS_LIMITS.familyWords}
                placeholder={ctx.t('wayIdeas.wordsHint')}
                value={words}
                onChange={(e) => setWords(e.target.value)}
              />
            </label>
            <Text quiet>
              {ctx.t(
                ctx.trialInput
                  ? 'wayIdeas.privacyTrial'
                  : ctx.fictional
                    ? 'wayIdeas.privacyFictional'
                    : 'wayIdeas.privacy',
              )}
            </Text>
            {context && <Text quiet>{sentNames(ctx, context)}</Text>}
            <Row>
              <Button
                onClick={() => void ask()}
                disabled={!context || state === 'working' || state === 'testOnly'}
              >
                {ctx.t(shown ? 'wayIdeas.again' : 'wayIdeas.send')}
              </Button>
            </Row>
            {state !== 'idle' && (
              <Text>
                {ctx.t(
                  state === 'limit' && ctx.trialInput ? 'wayIdeas.limitTrial' : `wayIdeas.${state}`,
                )}
              </Text>
            )}
          </Card>
        )}
        {shown && !fresh && (
          <Card tone="warn">
            <Text>{ctx.t('wayIdeas.outdated')}</Text>
          </Card>
        )}
        {shown && (
          <Ideas
            ctx={ctx}
            arrangementKey={arrangementKey}
            ideas={shown.ideas}
            sent={shown.sent}
            usable={fresh}
          />
        )}
      </Main>
    </>
  );
}

/** 送る名前の一行（家の情報から送る物は、名前と ID だけ）。 */
function sentNames(ctx: Ctx, context: WayIdeasContext): string {
  const h = context.household;
  const names = [
    ...h.adults.map((a) => a.name),
    ...h.helpers.map((p) => p.name),
    ...h.places.map((p) => p.name),
    ...h.ways.map((w) => w.name),
  ];
  return ctx.t('wayIdeas.sentNames', { names: names.join('・') });
}

function Ideas(props: {
  ctx: Ctx;
  arrangementKey: string;
  ideas: CheckedIdeas;
  sent: WayIdeasContext;
  usable: boolean;
}) {
  const { ctx, arrangementKey, ideas, sent, usable } = props;
  const stopped = new Set(ctx.household.stoppedWayIds ?? []);
  // Claude に送った時と同じ中身（名前と手順の名前）のやり方だけ（出した後に直したやり方に、前のわけを付けない）。
  const sentWays = new Map(sent.household.ways.map((w) => [w.id, w]));
  const unchanged = (way: { id: string; name: string; steps: { name: string }[] }) => {
    const before = sentWays.get(way.id);
    return (
      before !== undefined &&
      before.name === way.name &&
      JSON.stringify(before.steps) === JSON.stringify(way.steps.map((s) => s.name))
    );
  };
  const named = ideas.reuse.flatMap((r) => {
    const way = ctx.household.ways.find((w) => w.id === r.wayId);
    return way ? [{ ...r, way }] : [];
  });
  // 今も選べて、送った時から変わっていないやり方だけ出す（やめた物は出さない）。
  const reuse = named
    .filter((r) => !stopped.has(r.way.id) && unchanged(r.way))
    .map((r) => ({ wayId: r.wayId, why: r.why, name: r.way.name }));
  const changed = named.some((r) => !unchanged(r.way));
  return (
    <>
      {reuse.length > 0 && (
        <Card tone="accent">
          <Label tone="accent">{ctx.t('wayIdeas.reuseLabel')}</Label>
          {reuse.map((r) => (
            <div key={r.wayId} className="flex flex-col gap-0.5">
              <span className="font-bold">{r.name}</span>
              <span className="text-sm text-sub">{r.why}</span>
            </div>
          ))}
          <MoreLink onClick={() => ctx.go({ name: 'need', key: arrangementKey })}>
            {ctx.t('wayIdeas.reuseBack')}
          </MoreLink>
        </Card>
      )}
      {changed && (
        <Card tone="warn">
          <Text>{ctx.t('wayIdeas.reuseChanged')}</Text>
        </Card>
      )}
      {ideas.drafts.map((draft, index) => (
        <DraftCard
          // 案は出した順で一つずつ（同じ名前でも別の案）。
          // biome-ignore lint/suspicious/noArrayIndexKey: 案は番号で表に写す
          key={index}
          ctx={ctx}
          draft={draft}
          index={index}
          {...(usable
            ? { onUse: () => ctx.go({ name: 'way', from: arrangementKey, idea: index }) }
            : {})}
        />
      ))}
      {ideas.drafts.length === 0 && reuse.length === 0 && (
        <Card>
          {/* Claude が何も出さなかった時と、出した物が今は使えない時（やめた・出した後に直した）を分ける。 */}
          <Text>{ctx.t(ideas.reuse.length === 0 ? 'wayIdeas.none' : 'wayIdeas.noneUsable')}</Text>
          <MoreLink onClick={() => ctx.go({ name: 'way', from: arrangementKey })}>
            {ctx.t('wayIdeas.manual')}
          </MoreLink>
        </Card>
      )}
      {ideas.missing.length > 0 && (
        <Card>
          <Label tone="sub">{ctx.t('wayIdeas.missingLabel')}</Label>
          {ideas.missing.map((m) => (
            <Text key={m}>{m}</Text>
          ))}
        </Card>
      )}
      {ideas.notes.length > 0 && (
        <Card>
          <Label tone="sub">{ctx.t('wayIdeas.notesLabel')}</Label>
          {ideas.notes.map((n) => (
            <Text key={JSON.stringify(n)} quiet>
              {noteText(ctx, n)}
            </Text>
          ))}
        </Card>
      )}
    </>
  );
}

/** Claude にも分からなかった欄の数（表で家族が選ぶ）。外の事実の欄は数えない（いつも家族が入れる）。 */
function unknownCount(draft: CheckedDraft): number {
  let n = 0;
  for (const s of draft.steps) {
    if (s.assignee.kind === 'unknown') n += 1;
    if (s.counterpart.kind === 'unknown') n += 1;
    if (s.place.kind === 'unknown') n += 1;
    if (s.minutes === null) n += 1;
    if (s.segments === null) n += 1;
    if (s.cover === null) n += 1;
  }
  return n;
}

function DraftCard(props: { ctx: Ctx; draft: CheckedDraft; index: number; onUse?: () => void }) {
  const { ctx, draft, index, onUse } = props;
  const unknown = ctx.t('wayIdeas.unknownField');
  const contact = (id: string) => nameOf(ctx.household, id) || id;
  const count = unknownCount(draft);
  return (
    <Card>
      <Label tone="accent">{ctx.t('wayIdeas.draftLabel', { n: index + 1 })}</Label>
      <span className="font-bold">{draft.name}</span>
      {draft.why !== '' && <Text quiet>{draft.why}</Text>}
      <ol className="flex flex-col gap-2">
        {draft.steps.map((s, i) => {
          const who =
            s.assignee.kind === 'adult'
              ? nameOf(ctx.household, s.assignee.id)
              : s.assignee.kind === 'anyAdult'
                ? ctx.t('way.anyone')
                : unknown;
          const to =
            s.counterpart.kind === 'none'
              ? undefined
              : s.counterpart.kind === 'helper' || s.counterpart.kind === 'place'
                ? contact(s.counterpart.id)
                : s.counterpart.kind === 'unknown'
                  ? unknown
                  : ctx.t('wayIdeas.newName', { name: s.counterpart.name });
          const place =
            s.place.kind === 'none'
              ? undefined
              : s.place.kind === 'place'
                ? contact(s.place.id)
                : s.place.kind === 'unknown'
                  ? unknown
                  : ctx.t('wayIdeas.newName', { name: s.place.name });
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: 手順は順番そのもの
            <li key={i} className="flex flex-col gap-0.5">
              <span>
                {i + 1}. {s.name}
              </span>
              <span className="text-sm text-sub">{ctx.t('wayIdeas.stepWho', { who })}</span>
              {to !== undefined && (
                <span className="text-sm text-sub">{ctx.t('wayIdeas.stepTo', { to })}</span>
              )}
              {place !== undefined && (
                <span className="text-sm text-sub">{ctx.t('wayIdeas.stepPlace', { place })}</span>
              )}
              {s.cover === true && (
                <span className="text-sm text-sub">{ctx.t('wayIdeas.stepCover')}</span>
              )}
              <span className="text-sm text-sub">
                {s.quote && s.quoteFrom
                  ? ctx.t(`wayIdeas.quote.${s.quoteFrom}`, { quote: s.quote })
                  : ctx.t('wayIdeas.proposed')}
              </span>
            </li>
          );
        })}
      </ol>
      {count > 0 && <Text quiet>{ctx.t('wayIdeas.unknowns', { count })}</Text>}
      {draft.unclear.length > 0 && (
        <>
          <Label tone="sub">{ctx.t('wayIdeas.unclearLabel')}</Label>
          {draft.unclear.map((u) => (
            <Text key={u}>{u}</Text>
          ))}
        </>
      )}
      {draft.notes.length > 0 && (
        <>
          <Label tone="sub">{ctx.t('wayIdeas.notesLabel')}</Label>
          {draft.notes.map((n) => (
            <Text key={JSON.stringify(n)} quiet>
              {noteText(ctx, n)}
            </Text>
          ))}
        </>
      )}
      {onUse && (
        <Row>
          <Button kind="secondary" onClick={onUse}>
            {ctx.t('wayIdeas.use')}
          </Button>
        </Row>
      )}
    </Card>
  );
}
