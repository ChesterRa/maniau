// いつにするかの候補のある「すること」の画面（02-foundation §3.4.1）：候補 × 相手の答えの表、数え（はいの人数・
// たぶん・食い違い・まだの人を足した最大）、答えの条件、答えで変わりうる人（家族だけに見せる）、候補ごとのやり方と
// 決め時、勧め、決める。
// 相手の名簿と一人ずつのリンク、家族が聞いた答えの記録。計算はサーバー（見る口と命令）。保存は見た物と同じ時だけ。
import {
  localTimeOf,
  type NeedWhen,
  needStep,
  type Requirement,
  type SaveablePreview,
  toEpochMinutes,
} from '@maniau/core';
import { useEffect, useRef, useState } from 'react';
import { formatDay, formatDayTime, formatTime } from './format';
import { NeedActions, PreviewBlock, StalePreview, usePreviewSave } from './need';
import { type Ctx, Missing, nameOf } from './screens';
import { Button, Card, Header, Label, Main, MoreLink, Row, Text, Title } from './ui';

type Candidate = NeedWhen['candidates'][number];
type Answer = NeedWhen['answers'][number];

const input =
  'min-h-11 rounded-xl border-[1.5px] border-btn-line bg-white px-2.5 text-base text-ink';
const MARK = { yes: '○', maybe: '△', no: '×', conflict: '！' } as const;

/** 候補のある「すること」の要件（生きている物）。 */
export function whenRequirement(ctx: Ctx, requirementKey: string) {
  const requirement = ctx.plan.requirements.find(
    (r) => r.key === requirementKey && r.kind === 'need' && r.live && r.when !== undefined,
  );
  return requirement?.when ? { requirement, when: requirement.when } : undefined;
}

const personName = (ctx: Ctx, when: NeedWhen, personId: string) => {
  const person = when.people.find((p) => p.id === personId);
  return person?.kind === 'guest' ? (person.name ?? '') : nameOf(ctx.household, personId);
};

const answerOf = (when: NeedWhen, personId: string, candidateId: string): Answer | undefined =>
  when.answers.find((a) => a.personId === personId && a.candidateId === candidateId);

/** 12/9（水）13:00–15:00 */
function slot(ctx: Ctx, c: Pick<Candidate, 'date' | 'start' | 'end'>) {
  return ctx.t('when.slot', {
    day: formatDay(c.date, ctx.lang, ctx.tz),
    from: formatTime(c.start, ctx.lang, ctx.tz),
    to: formatTime(c.end, ctx.lang, ctx.tz),
  });
}

/** 決めた日（今の代）の候補。 */
const chosenCandidate = (when: NeedWhen): Candidate | undefined =>
  when.chosen &&
  when.candidates.find((c) => c.id === when.chosen?.candidateId && c.rev === when.chosen.rev);

/**
 * 日を決める事が残る「すること」：日を決めていない・決めた後に根拠の変わった・決めた日が後から記録した手が離せない
 * 時間と重なった（根拠は変わらないので、そのままでは見えなくなる）。きょうの一覧と、今やることがあるかの判定で使う。
 */
export function openWhen(ctx: Ctx): (Requirement & { when: NeedWhen })[] {
  return ctx.plan.requirements.filter(
    (r): r is Requirement & { when: NeedWhen } =>
      r.kind === 'need' &&
      r.live &&
      r.when !== undefined &&
      (!r.when.chosen || r.when.chosen.stale || chosenCandidate(r.when)?.unavailable !== undefined),
  );
}

/** きょうの画面：日を決める事が残る「すること」を、一行ずつ出す。 */
export function WhenList({ ctx }: { ctx: Ctx }) {
  const open = openWhen(ctx);
  if (open.length === 0) return null;
  return (
    <Card>
      <Label tone="sub">{ctx.t('when.list.label')}</Label>
      {open.map((r) => (
        <MoreLink key={r.key} onClick={() => ctx.go({ name: 'when', key: r.key })}>
          {ctx.t(
            !r.when.chosen
              ? 'when.list.item'
              : r.when.chosen.stale
                ? 'when.list.stale'
                : 'when.list.busy',
            { what: r.what, count: r.when.candidates.length },
          )}
        </MoreLink>
      ))}
    </Card>
  );
}

/**
 * 候補の時間が、答える家の人の記録した手が離せない時間と重なる時の一行（家族にだけ見せる。答えは変えない。本人が
 * 確かめた事でも、ほかの時間が空いている事でもない）。
 */
function BusyLine({ ctx, candidate: c }: { ctx: Ctx; candidate: Candidate }) {
  if (!c.unavailable) return null;
  const list = c.unavailable
    .map((u) =>
      ctx.t('when.busy.item', {
        name: nameOf(ctx.household, u.personId),
        from: formatTime(u.start, ctx.lang, ctx.tz),
        to: formatTime(u.end, ctx.lang, ctx.tz),
      }),
    )
    .join(ctx.t('when.join'));
  return <Text>{ctx.t('when.busy.line', { list })}</Text>;
}

export function WhenScreen({ ctx, requirementKey }: { ctx: Ctx; requirementKey: string }) {
  const found = whenRequirement(ctx, requirementKey);
  if (!found) return <Missing ctx={ctx} />;
  const { requirement, when } = found;
  const itemId = requirement.basis.itemIds[0] ?? '';
  const arrangement = ctx.plan.arrangements.find(
    (a) => a.requirementKey === requirement.key && a.kind === 'need' && a.live,
  );
  const chosen = when.chosen && when.candidates.find((c) => c.id === when.chosen?.candidateId);
  const item = ctx.items.find((x) => x.item.id === itemId)?.item;
  return (
    <>
      <Header
        back={{ label: ctx.t('nav.today'), onClick: () => ctx.go({ name: 'today' }) }}
        eyebrow={ctx.t('when.eyebrow')}
        title={requirement.what}
      />
      <Main>
        {chosen && when.chosen && (
          <Card tone={when.chosen.stale ? 'warn' : 'accent'}>
            <Label tone={when.chosen.stale ? 'warn' : 'accent'}>{ctx.t('when.chosen.label')}</Label>
            <Title>{slot(ctx, chosen)}</Title>
            <BusyLine ctx={ctx} candidate={chosen} />
            {when.chosen.stale && (
              <Text>
                {ctx.t('when.chosen.stale', {
                  changes: when.chosen.changes
                    .map((c) => ctx.t(`when.chosen.change.${c}`))
                    .join(ctx.t('when.join')),
                })}
              </Text>
            )}
            {when.inUse && <Text quiet>{ctx.t('when.chosen.inUse')}</Text>}
            {/* 日を決めても、その日のやり方をまだ選んでいなければ、手配は済んでいない（次にすることを言う）。 */}
            {arrangement && !when.chosen.stale && needStep(arrangement) === 'ways' && (
              <Text>{ctx.t('when.chosen.next')}</Text>
            )}
            {arrangement && (
              <MoreLink onClick={() => ctx.go({ name: 'need', key: arrangement.key })}>
                {ctx.t('when.chosen.open')}
              </MoreLink>
            )}
          </Card>
        )}
        <Card>
          <Label tone="sub">{ctx.t('when.table.label')}</Label>
          {when.people.length === 0 ? (
            <Text quiet>{ctx.t('when.table.noPeople')}</Text>
          ) : (
            <AnswerTable ctx={ctx} when={when} />
          )}
          {ctx.refresh && <MoreLink onClick={ctx.refresh}>{ctx.t('when.table.refresh')}</MoreLink>}
        </Card>
        <Recommendation ctx={ctx} when={when} />
        {when.candidates.map((c) => (
          <CandidateCard
            key={`${c.id}:${c.rev}`}
            ctx={ctx}
            when={when}
            candidate={c}
            itemId={itemId}
          />
        ))}
        <RecordAnswer
          key={when.candidates.map((c) => `${c.id}:${c.rev}`).join(',')}
          ctx={ctx}
          when={when}
          itemId={itemId}
        />
        <PeopleEditor
          key={JSON.stringify([when.people, when.required, when.minCount])}
          ctx={ctx}
          when={when}
          itemId={itemId}
        />
        {/* 頼んだ・引き受けた後は、日を替えられない（when.chosen.inUse で言う）。候補も直させない。 */}
        {!when.inUse && (
          <CandidatesEditor
            key={when.candidates.map((c) => `${c.id}:${c.rev}`).join(',')}
            ctx={ctx}
            when={when}
            itemId={itemId}
          />
        )}
        <Links ctx={ctx} when={when} itemId={itemId} />
        {item && <NeedActions key={item.id} ctx={ctx} item={item} />}
      </Main>
    </>
  );
}

/**
 * 行が候補、列が相手の表（○ △ × ー、食い違いは ！）。数は日のすぐ右に置く（人が多くても、送らずに見える）。表が枠に
 * 収まらない時だけ、横に送れることを言う。
 */
function AnswerTable({ ctx, when }: { ctx: Ctx; when: NeedWhen }) {
  const required = new Set(when.required);
  const box = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  // 描くたびと、窓の幅が変わるたびに確かめる（人を足すと、枠の幅は同じでも中身が広がる）。
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const check = () => setWide(element.scrollWidth > element.clientWidth + 1);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  });
  return (
    <>
      <div ref={box} className="-mx-1 overflow-x-auto">
        <table className="min-w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th className="sticky left-0 bg-card px-2 py-1.5 text-left font-bold text-sub">
                {ctx.t('when.table.date')}
              </th>
              <th className="whitespace-nowrap px-2 py-1.5 text-center font-bold text-sub">
                {ctx.t('when.table.count')}
              </th>
              {when.people.map((p) => (
                <th
                  key={p.id}
                  className="px-2 py-1.5 text-center font-bold text-sub"
                  title={personName(ctx, when, p.id)}
                >
                  <span className="inline-flex max-w-28 items-baseline">
                    <span className="truncate">{personName(ctx, when, p.id)}</span>
                    {required.has(p.id) && ctx.t('when.table.requiredMark')}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {when.candidates.map((c) => (
              <tr key={c.id}>
                <th className="sticky left-0 whitespace-nowrap bg-card px-2 py-1.5 text-left font-normal">
                  {formatDay(c.date, ctx.lang, ctx.tz)}
                  <br />
                  <span className="text-sub">
                    {ctx.t('when.range', {
                      from: formatTime(c.start, ctx.lang, ctx.tz),
                      to: formatTime(c.end, ctx.lang, ctx.tz),
                    })}
                  </span>
                </th>
                <td className="whitespace-nowrap px-2 py-1.5 text-center">
                  {ctx.t('when.table.yesOf', { yes: c.yes, possible: c.possible })}
                </td>
                {when.people.map((p) => {
                  const answer = answerOf(when, p.id, c.id);
                  return (
                    <td
                      key={p.id}
                      className={`px-2 py-1.5 text-center text-base ${answer?.value === 'conflict' ? 'font-bold text-warn' : ''}`}
                    >
                      {answer ? MARK[answer.value] : ctx.t('when.table.none')}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {wide && <Text quiet>{ctx.t('when.table.scroll')}</Text>}
      <Text quiet>{ctx.t('when.table.legend')}</Text>
      <Text quiet>{ctx.t('when.table.rule', { count: when.minCount })}</Text>
    </>
  );
}

function Recommendation({ ctx, when }: { ctx: Ctx; when: NeedWhen }) {
  const recommended = when.recommended;
  if (!recommended) {
    if (when.people.length === 0) return null;
    return (
      <Card>
        <Label tone="sub">{ctx.t('when.recommend.label')}</Label>
        <Text>{ctx.t('when.recommend.none')}</Text>
      </Card>
    );
  }
  const candidate = when.candidates.find((c) => c.id === recommended.candidateId);
  if (!candidate) return null;
  // 数に合わせて言う（答えの条件を満たす日が一つだけか、そのうち使えるやり方があるのが一つだけか）。ほかに、まだ
  // 決まらない日があれば添え、一番良いとは言わない。
  const reason =
    recommended.reason === 'onlyUsable' && recommended.meetsCount === 1
      ? 'onlyMeets'
      : recommended.reason;
  const openOthers = when.candidates.some((c) => c.id !== candidate.id && c.condition === 'open');
  return (
    <Card tone="accent">
      <Label tone="accent">{ctx.t('when.recommend.label')}</Label>
      <Title>{slot(ctx, candidate)}</Title>
      <Text>{ctx.t(`when.recommend.${reason}`, { meets: recommended.meetsCount })}</Text>
      <BusyLine ctx={ctx} candidate={candidate} />
      {openOthers && <Text quiet>{ctx.t('when.recommend.openOthers')}</Text>}
    </Card>
  );
}

function CandidateCard(props: { ctx: Ctx; when: NeedWhen; candidate: Candidate; itemId: string }) {
  const { ctx, when, candidate: c, itemId } = props;
  const flow = usePreviewSave(ctx);
  const names = (ids: readonly string[]) =>
    ids.map((id) => personName(ctx, when, id)).join(ctx.t('when.join'));
  const isChosen = when.chosen?.candidateId === c.id && when.chosen.rev === c.rev;
  const command: SaveablePreview = {
    type: 'chooseCandidate',
    itemId,
    candidateId: c.id,
    rev: c.rev,
  };
  const shown = flow.shownFor(command);
  const refused = flow.refusedFor(command);
  const notes = when.answers.filter(
    (a) => a.candidateId === c.id && (a.value === 'conflict' || a.sources.some((s) => s.note)),
  );
  // 使った後は、同じ候補・同じ代の決め直しだけ（サーバーと同じ決まり）。
  const canChoose = !(when.inUse && !isChosen) && (!isChosen || when.chosen?.stale === true);
  return (
    <Card>
      <Label tone={c.condition === 'meets' ? 'accent' : c.condition === 'cannot' ? 'warn' : 'sub'}>
        {ctx.t(`when.condition.${c.condition}`)}
      </Label>
      <Title>{slot(ctx, c)}</Title>
      <Text>{ctx.t('when.count', { yes: c.yes, possible: c.possible, count: when.minCount })}</Text>
      <BusyLine ctx={ctx} candidate={c} />
      {c.requiredNo.length > 0 && (
        <Text>{ctx.t('when.requiredNo', { names: names(c.requiredNo) })}</Text>
      )}
      {c.condition === 'open' && c.requiredOpen.length > 0 && (
        <Text>{ctx.t('when.requiredOpen', { names: names(c.requiredOpen) })}</Text>
      )}
      {c.pivotal.length > 0 && <Text>{ctx.t('when.pivotal', { names: names(c.pivotal) })}</Text>}
      {notes.map((a) => (
        <Text key={a.personId}>
          {a.value === 'conflict'
            ? ctx.t('when.conflict', {
                name: personName(ctx, when, a.personId),
                sources: a.sources
                  .map((s) =>
                    ctx.t('when.sourceAnswer', {
                      source: ctx.t(`when.source.${s.source}`),
                      answer: ctx.t(`when.answer.${s.answer}`),
                    }),
                  )
                  .join(ctx.t('when.join')),
              })
            : ctx.t('when.note', {
                name: personName(ctx, when, a.personId),
                notes: a.sources.flatMap((s) => (s.note ? [s.note] : [])).join(ctx.t('when.join')),
              })}
        </Text>
      ))}
      <WaysOf ctx={ctx} candidate={c} />
      {canChoose && (
        <>
          <PreviewBlock
            ctx={ctx}
            {...(shown ? { preview: shown } : {})}
            {...(refused ? { refused } : {})}
          />
          <Row>
            {shown ? (
              <Button onClick={() => void flow.save(command)} disabled={flow.busy}>
                {ctx.t(isChosen ? 'when.choose.again' : 'when.choose.save')}
              </Button>
            ) : (
              <Button
                kind="secondary"
                onClick={() => void flow.look(command)}
                disabled={flow.busy || !ctx.previewChange}
              >
                {ctx.t(isChosen ? 'when.choose.again' : 'when.choose.look')}
              </Button>
            )}
          </Row>
        </>
      )}
    </Card>
  );
}

/** 候補の日に、選んだやり方が使えるか・決め時（コードの計算）。 */
function WaysOf({ ctx, candidate: c }: { ctx: Ctx; candidate: Candidate }) {
  if (c.flags.includes('waysUndecided')) return <Text quiet>{ctx.t('when.ways.undecided')}</Text>;
  const nameOfWay = (id: string) => ctx.household.ways.find((w) => w.id === id)?.name ?? id;
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-paper px-3 py-2.5">
      {c.ways.map((w) => (
        <Text key={w.wayId}>
          {w.usable
            ? ctx.t('when.ways.usable', {
                way: nameOfWay(w.wayId),
                deadline: w.decisionDeadline
                  ? formatDayTime(w.decisionDeadline, ctx.lang, ctx.tz)
                  : '',
              })
            : ctx.t('when.ways.unusable', {
                way: nameOfWay(w.wayId),
                reasons: w.reasons.map((r) => ctx.t(`when.reason.${r}`)).join(ctx.t('when.join')),
              })}
          {w.costUnknown && ctx.t('when.ways.costUnknown')}
        </Text>
      ))}
      {c.flags.includes('noUsableWay') && <Text>{ctx.t('when.ways.none')}</Text>}
    </div>
  );
}

/** 家族が聞いた答え・自分の答えを記録する（自分なら自分の画面、ほかの人なら家族の記録）。 */
function RecordAnswer({ ctx, when, itemId }: { ctx: Ctx; when: NeedWhen; itemId: string }) {
  const [personId, setPersonId] = useState('');
  const [candidateId, setCandidateId] = useState(when.candidates[0]?.id ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>();
  if (when.people.length === 0) return null;
  const candidate = when.candidates.find((c) => c.id === candidateId);
  const record = async (answer: 'yes' | 'maybe' | 'no' | 'withdrawn') => {
    if (!personId || !candidate) return;
    setBusy(true);
    const result = await ctx.send({
      type: 'recordAvailability',
      itemId,
      candidateId: candidate.id,
      rev: candidate.rev,
      personId,
      answer,
      ...(answer !== 'withdrawn' && note.trim() ? { note: note.trim() } : {}),
    });
    setBusy(false);
    if (result.status === 'ok' || result.status === 'noop') {
      setNote('');
      setDone(ctx.t('when.record.done'));
    } else setDone(undefined);
  };
  const field = 'flex flex-col gap-1';
  const label = 'text-sm font-bold text-sub';
  return (
    <Card>
      <Label tone="sub">{ctx.t('when.record.label')}</Label>
      <Text quiet>{ctx.t('when.record.note')}</Text>
      <label className={field}>
        <span className={label}>{ctx.t('when.record.person')}</span>
        <select className={input} value={personId} onChange={(e) => setPersonId(e.target.value)}>
          <option value="">{ctx.t('when.record.choose')}</option>
          {when.people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id === ctx.me.id ? ctx.t('when.record.me') : personName(ctx, when, p.id)}
            </option>
          ))}
        </select>
      </label>
      <label className={field}>
        <span className={label}>{ctx.t('when.record.candidate')}</span>
        <select
          className={input}
          value={candidateId}
          onChange={(e) => setCandidateId(e.target.value)}
        >
          {when.candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {slot(ctx, c)}
            </option>
          ))}
        </select>
      </label>
      <label className={field}>
        <span className={label}>{ctx.t('when.record.maybeNote')}</span>
        <input
          className={input}
          maxLength={140}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <Row>
        {(['yes', 'maybe', 'no'] as const).map((answer) => (
          <Button
            key={answer}
            kind="secondary"
            onClick={() => void record(answer)}
            disabled={busy || !personId}
          >
            {ctx.t(`when.record.${answer}`)}
          </Button>
        ))}
      </Row>
      <MoreLink onClick={() => void record('withdrawn')}>{ctx.t('when.record.withdraw')}</MoreLink>
      {done && <Text quiet>{done}</Text>}
    </Card>
  );
}

/** 答える相手（家の大人・頼める人・名前だけの相手）、要る人、少なくとも何人。 */
function PeopleEditor({ ctx, when, itemId }: { ctx: Ctx; when: NeedWhen; itemId: string }) {
  const candidates = ctx.household.members.filter(
    (m) => m.active && (m.kind === 'adult' || m.kind === 'helper'),
  );
  const [members, setMembers] = useState(
    () => new Set(when.people.filter((p) => p.kind === 'member').map((p) => p.id)),
  );
  const [guests, setGuests] = useState<{ key: string; id?: string; name: string }[]>(() =>
    when.people
      .filter((p) => p.kind === 'guest')
      .map((p) => ({ key: p.id, id: p.id, name: p.name ?? '' })),
  );
  const [required, setRequired] = useState(() => new Set(when.required));
  const [minCount, setMinCount] = useState(String(when.minCount));
  const [open, setOpen] = useState(when.people.length === 0);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string>();
  if (!open) {
    return <MoreLink onClick={() => setOpen(true)}>{ctx.t('when.people.edit')}</MoreLink>;
  }
  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };
  const named = guests.filter((g) => g.name.trim() !== '');
  const everyone = [...members, ...named.flatMap((g) => (g.id ? [g.id] : []))];
  const count = Number(minCount);
  const save = async () => {
    setBusy(true);
    const result = await ctx.send({
      type: 'setNeedPeople',
      itemId,
      members: [...members],
      guests: named.map((g) => ({ ...(g.id ? { id: g.id } : {}), name: g.name.trim() })),
      required: [...required].filter((id) => everyone.includes(id)),
      minCount: Number.isInteger(count) && count >= 0 ? count : 0,
    });
    setBusy(false);
    if (result.status === 'ok' || result.status === 'noop') {
      setRefused(undefined);
      setOpen(false);
    } else setRefused('reason' in result ? (result.reason ?? 'other') : 'other');
  };
  return (
    <Card>
      <Label tone="sub">{ctx.t('when.people.label')}</Label>
      <Text quiet>{ctx.t('when.people.note')}</Text>
      {candidates.map((m) => (
        <div key={m.id} className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="size-5 accent-accent"
              checked={members.has(m.id)}
              onChange={() => setMembers((s) => toggle(s, m.id))}
            />
            {m.name}
          </label>
          {members.has(m.id) && (
            <label className="flex items-center gap-2 text-sm text-sub">
              <input
                type="checkbox"
                className="size-4 accent-accent"
                checked={required.has(m.id)}
                onChange={() => setRequired((s) => toggle(s, m.id))}
              />
              {ctx.t('when.people.required')}
            </label>
          )}
        </div>
      ))}
      {guests.map((g, index) => (
        <div key={g.key} className="flex flex-wrap items-center gap-2">
          <input
            className={`${input} min-w-0 flex-1`}
            maxLength={40}
            placeholder={ctx.t('when.people.guestName')}
            value={g.name}
            onChange={(e) =>
              setGuests((list) =>
                list.map((x, i) => (i === index ? { ...x, name: e.target.value } : x)),
              )
            }
          />
          {g.id && (
            <label className="flex items-center gap-2 text-sm text-sub">
              <input
                type="checkbox"
                className="size-4 accent-accent"
                checked={required.has(g.id)}
                onChange={() => setRequired((s) => toggle(s, g.id ?? ''))}
              />
              {ctx.t('when.people.required')}
            </label>
          )}
          <MoreLink onClick={() => setGuests((list) => list.filter((_, i) => i !== index))}>
            {ctx.t('when.people.remove')}
          </MoreLink>
        </div>
      ))}
      <MoreLink
        onClick={() => setGuests((list) => [...list, { key: `new-${Date.now()}`, name: '' }])}
      >
        {ctx.t('when.people.addGuest')}
      </MoreLink>
      <Text quiet>{ctx.t('when.people.newGuestRequired')}</Text>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-bold text-sub">{ctx.t('when.people.minCount')}</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={60}
          className={`${input} w-24`}
          value={minCount}
          onChange={(e) => setMinCount(e.target.value)}
        />
      </label>
      {refused && <Text>{ctx.t(`when.refused.${refusedKey(refused)}`)}</Text>}
      <Row>
        <Button onClick={() => void save()} disabled={busy}>
          {ctx.t('when.people.save')}
        </Button>
      </Row>
    </Card>
  );
}

const refusedKey = (reason: string) =>
  [
    'personUnknown',
    'requiredNotInPeople',
    'minCountTooLarge',
    'personDuplicate',
    'linksDemoOnly',
    'tooManyLinks',
  ].includes(reason)
    ? reason
    : 'other';

/**
 * 候補の日を直す（足す・時間を直す・外す。2〜8）。前からある候補は id を付けて全部を送り、サーバーが時間の変わった
 * 候補の代を進める（前の代への答えは当てない。外した候補の id は使い回さない）。保存の前に、計画で変わることと、画面に
 * ある答えと決めた日から確かに言えること（数えなくなる答え・外れる決めた日・まだ答えの無い足した候補）を見せる。
 * 頼んだ・引き受けた後は出さない（日を替えられない）。答えるリンクは今のまま使え、今の候補が出る。
 */
function CandidatesEditor({ ctx, when, itemId }: { ctx: Ctx; when: NeedWhen; itemId: string }) {
  const timeOf = (at: string) => localTimeOf(toEpochMinutes(at), ctx.tz);
  const current = () =>
    when.candidates.map((c, key) => ({
      key,
      id: c.id as string | undefined,
      date: c.date,
      from: timeOf(c.start),
      to: timeOf(c.end),
    }));
  const [open, setOpen] = useState(false);
  const [slots, setSlots] = useState(current);
  const flow = usePreviewSave(ctx);
  if (!open) {
    return <MoreLink onClick={() => setOpen(true)}>{ctx.t('when.candidates.edit')}</MoreLink>;
  }
  const filled =
    slots.length >= 2 &&
    slots.length <= 8 &&
    slots.every((s) => s.date !== '' && s.from !== '' && s.to !== '');
  const command: SaveablePreview | undefined = filled
    ? {
        type: 'setNeedCandidates',
        itemId,
        candidates: slots.map((s) => ({
          ...(s.id ? { id: s.id } : {}),
          date: s.date,
          startTime: s.from,
          endTime: s.to,
        })),
      }
    : undefined;
  const shown = command && flow.shownFor(command);
  const refused = command && flow.refusedFor(command);
  // 見た時のサーバーの記録が、この画面の計画より新しい（開いた後に答えや候補が変わった）時は、下の書き添えが古い
  // 答えから数えた物になるので、出さずに画面を更新してもらう（保存も出さない）。
  const stale = shown !== undefined && shown.throughSeq !== ctx.plan.throughSeq;
  // 画面にある答えと決めた日から、この直しで確かに変わること。
  const notes: string[] = [];
  for (const c of when.candidates) {
    const next = slots.find((s) => s.id === c.id);
    const moved =
      next !== undefined &&
      (next.date !== c.date || next.from !== timeOf(c.start) || next.to !== timeOf(c.end));
    if (next && !moved) continue;
    const answered = when.answers.filter((a) => a.candidateId === c.id).length;
    if (answered > 0) {
      notes.push(
        ctx.t(next ? 'when.candidates.answersReset' : 'when.candidates.answersRemoved', {
          slot: slot(ctx, c),
          count: answered,
        }),
      );
    }
    if (when.chosen?.candidateId === c.id && when.chosen.rev === c.rev) {
      notes.push(ctx.t('when.candidates.chosenLost', { slot: slot(ctx, c) }));
    }
  }
  const added = slots.filter((s) => s.id === undefined).length;
  if (added > 0) notes.push(ctx.t('when.candidates.added', { count: added }));
  const set = (key: number, change: Partial<{ date: string; from: string; to: string }>) =>
    setSlots((list) => list.map((x) => (x.key === key ? { ...x, ...change } : x)));
  const save = async () => {
    if (command && (await flow.save(command))) setOpen(false);
  };
  return (
    <Card>
      <Label tone="sub">{ctx.t('when.candidates.label')}</Label>
      <Text quiet>{ctx.t('when.candidates.note')}</Text>
      {slots.map((s, index) => (
        <div key={s.key} className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-sm text-sub">
              {ctx.t('when.candidates.candidate', { n: index + 1 })}
            </span>
            <input
              type="date"
              className={input}
              value={s.date}
              onChange={(e) => set(s.key, { date: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-sub">{ctx.t('when.candidates.from')}</span>
            <input
              type="time"
              className={input}
              value={s.from}
              onChange={(e) => set(s.key, { from: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-sub">{ctx.t('when.candidates.to')}</span>
            <input
              type="time"
              className={input}
              value={s.to}
              onChange={(e) => set(s.key, { to: e.target.value })}
            />
          </label>
          {slots.length > 2 && (
            <MoreLink onClick={() => setSlots((list) => list.filter((x) => x.key !== s.key))}>
              {ctx.t('when.candidates.remove')}
            </MoreLink>
          )}
        </div>
      ))}
      {slots.length < 8 && (
        <MoreLink
          onClick={() =>
            setSlots((list) => [
              ...list,
              {
                key: Math.max(...list.map((x) => x.key)) + 1,
                id: undefined,
                date: list.at(-1)?.date ?? '',
                from: list.at(-1)?.from ?? '',
                to: list.at(-1)?.to ?? '',
              },
            ])
          }
        >
          {ctx.t('when.candidates.add')}
        </MoreLink>
      )}
      {stale ? (
        <StalePreview ctx={ctx} />
      ) : (
        <PreviewBlock
          ctx={ctx}
          {...(shown ? { preview: shown } : {})}
          {...(refused ? { refused } : {})}
          notes={notes}
        />
      )}
      <Row>
        {shown && !stale ? (
          <Button onClick={() => void save()} disabled={flow.busy}>
            {ctx.t('when.candidates.save')}
          </Button>
        ) : (
          <Button
            kind="secondary"
            onClick={() => command && void flow.look(command)}
            disabled={flow.busy || !command || !ctx.previewChange}
          >
            {ctx.t('when.candidates.look')}
          </Button>
        )}
        {/* やめる時は、直しかけた欄を今の候補に戻す。 */}
        <Button
          kind="secondary"
          onClick={() => {
            setSlots(current());
            setOpen(false);
          }}
          disabled={flow.busy}
        >
          {ctx.t('when.candidates.cancel')}
        </Button>
      </Row>
    </Card>
  );
}

/** 一人ずつの答えるリンク：出す・出し直す・止める。鍵は出した時に一度だけ見せる（写せるようにする）。 */
function Links({ ctx, when, itemId }: { ctx: Ctx; when: NeedWhen; itemId: string }) {
  const [issued, setIssued] = useState<{ personId: string; url: string }>();
  const [refused, setRefused] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const others = when.people.filter((p) => p.id !== ctx.me.id);
  if (others.length === 0) return null;
  const issue = async (personId: string) => {
    setBusy(true);
    const result = await ctx.send({ type: 'issueAnswerLink', itemId, personId });
    setBusy(false);
    setCopied(false);
    if ((result.status === 'ok' || result.status === 'noop') && 'answerLink' in result) {
      const token = result.answerLink?.token;
      if (token) {
        setIssued({ personId, url: `${window.location.origin}/answer#${token}` });
        setRefused(undefined);
        return;
      }
    }
    setIssued(undefined);
    setRefused('reason' in result ? (result.reason ?? 'other') : 'other');
  };
  const revoke = async (personId: string) => {
    setBusy(true);
    await ctx.send({ type: 'revokeAnswerLink', itemId, personId });
    setBusy(false);
    if (issued?.personId === personId) setIssued(undefined);
  };
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Card>
      <Label tone="sub">{ctx.t('when.links.label')}</Label>
      <Text quiet>{ctx.t('when.links.note')}</Text>
      {others.map((p) => {
        const active = when.links.some((l) => l.personId === p.id && l.active);
        return (
          <div key={p.id} className="flex flex-col gap-1">
            <Text>
              {ctx.t(active ? 'when.links.active' : 'when.links.inactive', {
                name: personName(ctx, when, p.id),
              })}
            </Text>
            <Row>
              <Button kind="secondary" onClick={() => void issue(p.id)} disabled={busy}>
                {ctx.t(active ? 'when.links.reissue' : 'when.links.issue')}
              </Button>
              {active && (
                <Button kind="secondary" onClick={() => void revoke(p.id)} disabled={busy}>
                  {ctx.t('when.links.revoke')}
                </Button>
              )}
            </Row>
            {issued?.personId === p.id && (
              <div className="flex flex-col gap-1 rounded-xl bg-paper px-3 py-2.5">
                <Text>{ctx.t('when.links.once')}</Text>
                <input
                  readOnly
                  className={`${input} text-sm`}
                  value={issued.url}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Row>
                  <Button kind="secondary" onClick={() => void copy(issued.url)}>
                    {ctx.t(copied ? 'when.links.copied' : 'when.links.copy')}
                  </Button>
                </Row>
                <Text quiet>{ctx.t('when.links.warning')}</Text>
              </div>
            )}
          </div>
        );
      })}
      {refused && <Text>{ctx.t(`when.refused.${refusedKey(refused)}`)}</Text>}
    </Card>
  );
}
