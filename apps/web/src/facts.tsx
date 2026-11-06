// 子の居場所の足りない事実を聞く（要件の missingAdults）：その日にだれが子を見られるか。分からない所は、手配が
// 要るとも要らないとも決めない。答えは家の情報の直し（見る → 見た物で書く）で記録する。
// - ふだんの平日の型（出社・在宅で仕事・時短・家にいる）は、具体の時刻を出して直せるようにし、「この時間の前と後は
//   家にいて、子を見られる」まで確かめた時だけ、平日の一日の記録（allDay）にする。
// - その日の答えは、ふだんどおり・一日見られる・見られない時間がある・見られる時間だけ分かる・分からない。
// あわせて、取れる手を足す札（頼める人に頼む・学童に一日預ける・大人が休む。決まった形で、締切などを選んで足す）。
import {
  AFTER_SCHOOL_MAX_DAYS,
  AFTER_SCHOOL_WEEKDAYS,
  type AfterSchoolDeadline,
  afterSchoolOption,
  type DayAnswer,
  HELPER_ASK_DAYS,
  type Household,
  helperAskOption,
  LEAVE_MAX_BUSINESS_DAYS,
  leaveOption,
  type Requirement,
  type RoutineDay,
  type TodayCard,
  weekdayOf,
} from '@maniau/core';
import { useState } from 'react';
import { ConditionLine, type Ctx, day, nameOf, timeOnly } from './screens';
import { Button, Card, Header, Label, Main, MoreLink, Row, Text, Title } from './ui';
import { Shown, useHouseholdSave } from './ways';

const field = 'min-h-11 rounded-xl border border-line bg-card px-2 text-base';

/** 要件の子（キーの最後。子の居場所の要件は子ごと）。 */
const childOf = (requirement: Requirement) => requirement.key.split(':').at(-1);

/** 分からない時間が、その日の全部か。 */
const wholeDay = (requirement: Requirement) => {
  const [only, ...rest] = requirement.unsure ?? [];
  return (
    rest.length === 0 &&
    only !== undefined &&
    only.start.slice(11, 16) === '00:00' &&
    only.end.slice(11, 16) === '00:00' &&
    only.start.slice(0, 10) !== only.end.slice(0, 10)
  );
};

export function FactsCard({
  ctx,
  card,
}: {
  ctx: Ctx;
  card: Extract<TodayCard, { kind: 'facts' }>;
}) {
  const { requirement } = card;
  // 文の中の並びは、言葉ごとの並べ方で（英語は「A and B」。費用などの区切り「・」は使わない）。
  const list = (parts: string[]) =>
    new Intl.ListFormat(ctx.lang, { type: 'conjunction' }).format(parts);
  const who = list((requirement.missingAdults ?? []).map((id) => nameOf(ctx.household, id)));
  const times = list(
    (requirement.unsure ?? []).map((s) => `${timeOnly(ctx, s.start)}–${timeOnly(ctx, s.end)}`),
  );
  // なぜその日に見る人が要るか（読み取りの言葉のまま、見出しのように。一文で言い切らない：条件しだいの物は、次の
  // 一行が条件を書く）と、元の文へ戻る入口（元の文が手元にある時だけ）。
  const item = ctx.items.find((l) => requirement.basis.itemIds.includes(l.item.id))?.item;
  const source = item && ctx.sources.get(item.sourceId);
  return (
    <Card>
      <Label tone="warn">{ctx.t('card.facts.label')}</Label>
      <Title>
        {ctx.t('card.facts.title', {
          date: requirement.date ? day(ctx, requirement.date) : '',
          child: nameOf(ctx.household, childOf(requirement)),
        })}
      </Title>
      {requirement.what && <Text>{ctx.t('card.facts.why', { what: requirement.what })}</Text>}
      <ConditionLine
        ctx={ctx}
        basis={{ itemIds: requirement.basis.itemIds, requirementKey: requirement.key }}
      />
      <Text>
        {wholeDay(requirement)
          ? ctx.t('card.facts.wholeDay', { who })
          : ctx.t('card.facts.times', { who, times })}
      </Text>
      {item && source && (
        <MoreLink
          onClick={() =>
            ctx.go({ name: 'sources', sourceId: item.sourceId, highlight: item.sentenceIds })
          }
        >
          {source.title
            ? ctx.t('card.question.sourceTitled', { title: source.title })
            : ctx.t('card.question.source')}
        </MoreLink>
      )}
      <Button onClick={() => ctx.go({ name: 'facts', key: requirement.key })}>
        {ctx.t('card.facts.action')}
      </Button>
    </Card>
  );
}

type WeekKind = 'office' | 'remote' | 'short' | 'home' | 'unknown';
type DayKind = 'usual' | 'all' | 'notSome' | 'someOnly' | 'unknown';
interface Answer {
  week?: WeekKind;
  weekStart: string;
  weekEnd: string;
  day?: DayKind;
  dayStart: string;
  dayEnd: string;
  rest: 'can' | 'unknown';
}

const WEEK_TIMES: Record<'office' | 'remote' | 'short', [string, string]> = {
  office: ['08:00', '19:00'],
  remote: ['09:00', '18:00'],
  short: ['08:30', '16:30'],
};
const MORNING = '06:00';
const NIGHT = '23:00';

/** 平日（月〜金）の一日：家 → 仕事 → 家（家で仕事をする時も「仕事」：子は見られない）。 */
function weekdays(memberId: string, kind: WeekKind, start: string, end: string): RoutineDay[] {
  const segments =
    kind === 'home'
      ? [{ start: MORNING, end: NIGHT, kind: 'home' as const, viaStationIds: [] }]
      : [
          { start: MORNING, end: start, kind: 'home' as const, viaStationIds: [] },
          { start, end, kind: 'work' as const, viaStationIds: [] },
          { start: end, end: NIGHT, kind: 'home' as const, viaStationIds: [] },
        ];
  return [1, 2, 3, 4, 5].map((weekday) => ({ memberId, weekday, segments, allDay: true }));
}

const weekReady = (a: Answer) =>
  a.week === undefined ||
  a.week === 'unknown' ||
  a.week === 'home' ||
  (MORNING < a.weekStart && a.weekStart < a.weekEnd && a.weekEnd < NIGHT);
const dayReady = (a: Answer) =>
  a.day === undefined || (a.day !== 'notSome' && a.day !== 'someOnly') || a.dayStart < a.dayEnd;

export function FactsScreen({ ctx, requirementKey }: { ctx: Ctx; requirementKey: string }) {
  const requirement = ctx.plan.requirements.find((r) => r.key === requirementKey);
  const date = requirement?.date;
  const adults = (requirement?.missingAdults ?? []).filter((id) =>
    ctx.household.members.some((m) => m.id === id && m.kind === 'adult' && m.active),
  );
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const flow = useHouseholdSave(ctx);
  const back = { label: ctx.t('nav.today'), onClick: () => ctx.go({ name: 'today' }) };
  if (!requirement || !date || adults.length === 0) {
    return (
      <>
        <Header back={back} title={ctx.t('facts.gone')} />
        <Main>
          <Text>{ctx.t('facts.goneBody')}</Text>
        </Main>
      </>
    );
  }
  const weekday = weekdayOf(date);
  const answerOf = (id: string): Answer =>
    answers[id] ?? {
      weekStart: WEEK_TIMES.office[0],
      weekEnd: WEEK_TIMES.office[1],
      dayStart: '09:00',
      dayEnd: '18:00',
      // それ以外の時間は、家族が「見られる」と選んだ時だけ見られるとする（初めは分からない）。
      rest: 'unknown',
    };
  const set = (id: string, change: Partial<Answer>) => {
    setAnswers((all) => ({ ...all, [id]: { ...answerOf(id), ...change } }));
  };
  /** 平日の一日の記録が、もうあるか（無い大人にだけ、平日の型を聞く）。 */
  const hasWeek = (id: string) => ctx.household.routines.some((r) => r.memberId === id);
  /**
   * 「ふだんどおり」を出せるか：その日の曜日に、ふだんの一日がある（今の記録、またはここで選んだ平日の型）。その日だけの
   * 一日がある人には出さない（その日の答えを外すと、ふだんではなく、その日だけの一日に戻るので、名前と計算が食い違う）。
   */
  const hasUsual = (id: string) => {
    const a = answerOf(id);
    if (ctx.household.routineExceptions.some((e) => e.memberId === id && e.date === date)) {
      return false;
    }
    return (
      ctx.household.routines.some((r) => r.memberId === id && r.weekday === weekday) ||
      (a.week !== undefined && a.week !== 'unknown' && weekday <= 5)
    );
  };

  const draft = (): Household => {
    const next = structuredClone(ctx.household);
    for (const id of adults) {
      const a = answerOf(id);
      if (!hasWeek(id) && a.week && a.week !== 'unknown') {
        next.routines.push(...weekdays(id, a.week, a.weekStart, a.weekEnd));
      }
      if (a.day === undefined) continue;
      const others = (next.dayAnswers ?? []).filter((x) => !(x.memberId === id && x.date === date));
      const span = [{ start: a.dayStart, end: a.dayEnd }];
      const answer: DayAnswer | undefined =
        a.day === 'usual'
          ? undefined
          : a.day === 'all'
            ? { memberId: id, date, can: [], cannot: [], rest: 'can' }
            : a.day === 'notSome'
              ? { memberId: id, date, can: [], cannot: span, rest: a.rest }
              : a.day === 'someOnly'
                ? { memberId: id, date, can: span, cannot: [], rest: 'unknown' }
                : { memberId: id, date, can: [], cannot: [], rest: 'unknown' };
      const list = answer ? [...others, answer] : others;
      if (list.length > 0) next.dayAnswers = list;
      else delete next.dayAnswers;
    }
    return next;
  };
  const anything = adults.some((id) => {
    const a = answerOf(id);
    return (a.week !== undefined && a.week !== 'unknown' && !hasWeek(id)) || a.day !== undefined;
  });
  const ready = adults.every((id) => weekReady(answerOf(id)) && dayReady(answerOf(id)));

  // 見た物は、見た時の家の情報と一緒に持つ（欄を替えれば見せない。前に頼んだ遅れた答えも使わない）。
  const next = draft();
  const preview = flow.shownFor(next);
  const refused = flow.refusedFor(next);
  const child = nameOf(ctx.household, childOf(requirement));

  return (
    <>
      <Header back={back} title={ctx.t('facts.title', { date: day(ctx, date), child })} />
      <Main>
        <Text>{ctx.t('facts.intro')}</Text>
        {adults.map((id) => {
          const a = answerOf(id);
          const name = nameOf(ctx.household, id);
          return (
            <Card key={id}>
              <Title>{name}</Title>
              {!hasWeek(id) && (
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-1 font-bold">{ctx.t('facts.week.label')}</legend>
                  {(['office', 'remote', 'short', 'home', 'unknown'] as const).map((kind) => (
                    <Choice
                      key={kind}
                      name={`week-${id}`}
                      checked={a.week === kind}
                      label={ctx.t(`facts.week.${kind}`)}
                      onChange={() =>
                        set(id, {
                          week: kind,
                          ...(kind === 'office' || kind === 'remote' || kind === 'short'
                            ? { weekStart: WEEK_TIMES[kind][0], weekEnd: WEEK_TIMES[kind][1] }
                            : {}),
                        })
                      }
                    />
                  ))}
                  {(a.week === 'office' || a.week === 'remote' || a.week === 'short') && (
                    <>
                      <Times
                        ctx={ctx}
                        start={a.weekStart}
                        end={a.weekEnd}
                        onChange={(weekStart, weekEnd) => set(id, { weekStart, weekEnd })}
                      />
                      <Text quiet>
                        {ctx.t(`facts.week.${a.week}Line`, {
                          start: a.weekStart,
                          end: a.weekEnd,
                        })}
                      </Text>
                    </>
                  )}
                  {a.week === 'home' && <Text quiet>{ctx.t('facts.week.homeLine')}</Text>}
                  {a.week !== undefined && !weekReady(a) && (
                    <Text>{ctx.t('facts.week.badTimes')}</Text>
                  )}
                </fieldset>
              )}
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 font-bold">
                  {ctx.t('facts.day.label', { date: day(ctx, date) })}
                </legend>
                {(['usual', 'all', 'notSome', 'someOnly', 'unknown'] as const)
                  .filter((kind) => kind !== 'usual' || hasUsual(id))
                  .map((kind) => (
                    <Choice
                      key={kind}
                      name={`day-${id}`}
                      checked={a.day === kind}
                      label={ctx.t(`facts.day.${kind}`)}
                      onChange={() =>
                        set(id, {
                          day: kind,
                          ...(kind === 'someOnly' ? { dayStart: '09:00', dayEnd: '12:00' } : {}),
                          ...(kind === 'notSome' ? { dayStart: '09:00', dayEnd: '18:00' } : {}),
                        })
                      }
                    />
                  ))}
                {(a.day === 'notSome' || a.day === 'someOnly') && (
                  <Times
                    ctx={ctx}
                    start={a.dayStart}
                    end={a.dayEnd}
                    onChange={(dayStart, dayEnd) => set(id, { dayStart, dayEnd })}
                  />
                )}
                {a.day === 'notSome' && (
                  <label className="flex flex-wrap items-center gap-2">
                    <span>{ctx.t('facts.day.rest')}</span>
                    <select
                      className={field}
                      value={a.rest}
                      onChange={(e) =>
                        set(id, { rest: e.target.value === 'unknown' ? 'unknown' : 'can' })
                      }
                    >
                      <option value="unknown">{ctx.t('facts.day.restUnknown')}</option>
                      <option value="can">{ctx.t('facts.day.restCan')}</option>
                    </select>
                  </label>
                )}
                {a.day === 'someOnly' && <Text quiet>{ctx.t('facts.day.someOnlyLine')}</Text>}
                {a.day !== undefined && !dayReady(a) && <Text>{ctx.t('facts.day.badTimes')}</Text>}
              </fieldset>
            </Card>
          );
        })}
        <Shown
          ctx={ctx}
          {...(preview ? { preview } : {})}
          {...(refused ? { refused } : {})}
          household={next}
        />
        <Row>
          {preview ? (
            <Button
              onClick={() =>
                void flow.save(next).then((ok) => {
                  if (ok) ctx.go({ name: 'today' });
                })
              }
              disabled={flow.busy}
            >
              {ctx.t('facts.save')}
            </Button>
          ) : (
            <Button
              onClick={() => void flow.look(next)}
              disabled={flow.busy || !anything || !ready}
            >
              {ctx.t('facts.look')}
            </Button>
          )}
        </Row>
      </Main>
    </>
  );
}

function Choice(props: { name: string; label: string; checked: boolean; onChange: () => void }) {
  return (
    <label className="flex min-h-11 items-center gap-2.5 rounded-xl border border-line bg-card px-3">
      <input
        type="radio"
        name={props.name}
        checked={props.checked}
        onChange={props.onChange}
        className="size-5 accent-accent"
      />
      <span>{props.label}</span>
    </label>
  );
}

function Times(props: {
  ctx: Ctx;
  start: string;
  end: string;
  onChange: (start: string, end: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="time"
        aria-label={props.ctx.t('facts.start')}
        className={field}
        value={props.start}
        onChange={(e) => props.onChange(e.target.value, props.end)}
      />
      <span>–</span>
      <input
        type="time"
        aria-label={props.ctx.t('facts.end')}
        className={field}
        value={props.end}
        onChange={(e) => props.onChange(props.start, e.target.value)}
      />
    </div>
  );
}

type AddKind = 'helper' | 'afterSchool' | 'leave';
const ADD_KINDS: readonly AddKind[] = ['helper', 'afterSchool', 'leave'];
/** 新しく足す成員・場所の ID（サーバーの決まり：英小文字・数字・ハイフン）。 */
const newId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * 取れる手を足す：頼める人に頼む・学童に一日預ける・大人が休む、の決まった形の三つから選び、家族が選ぶ所（呼び名・
 * 締切・学童の費用とお弁当・休む人）だけを入れて足す。見てから足す（家の情報の直しと同じ）。締切は、家族が選ぶまで
 * 決めない（初めの値で黙って記録しない）。
 */
export function CareOptionAddCard({ ctx }: { ctx: Ctx }) {
  const [kind, setKind] = useState<AddKind>('helper');
  const [added, setAdded] = useState<string>();
  if (added) {
    return (
      <Card>
        <Text>{ctx.t('careAdd.added', { name: added })}</Text>
      </Card>
    );
  }
  return (
    <Card>
      <Label tone="sub">{ctx.t('careAdd.label')}</Label>
      <Text quiet>{ctx.t('careAdd.body')}</Text>
      <div className="flex flex-wrap gap-1.5">
        {ADD_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            aria-pressed={k === kind}
            className={`min-h-11 rounded-xl border-[1.5px] px-3 font-bold ${k === kind ? 'border-accent bg-accent text-white' : 'border-btn-line bg-white'}`}
          >
            {ctx.t(`careAdd.kind.${k}`)}
          </button>
        ))}
      </div>
      {kind === 'helper' && <HelperForm ctx={ctx} onAdded={setAdded} />}
      {kind === 'afterSchool' && <AfterSchoolForm ctx={ctx} onAdded={setAdded} />}
      {kind === 'leave' && <LeaveForm ctx={ctx} onAdded={setAdded} />}
    </Card>
  );
}

/** 見る → 足す（家の情報の直しと同じ流れ）。next が無い・ready でない間は、見ることもできない。 */
function AddFlow(props: {
  ctx: Ctx;
  next: Household | undefined;
  ready: boolean;
  name: string;
  onAdded: (name: string) => void;
}) {
  const { ctx, next, ready, name } = props;
  const flow = useHouseholdSave(ctx);
  const preview = ready && next ? flow.shownFor(next) : undefined;
  const refused = ready && next ? flow.refusedFor(next) : undefined;
  return (
    <>
      <Shown
        ctx={ctx}
        {...(preview ? { preview } : {})}
        {...(refused ? { refused } : {})}
        {...(next ? { household: next } : {})}
      />
      <Row>
        {preview && next ? (
          <Button
            onClick={() =>
              void flow.save(next).then((ok) => {
                if (ok) props.onAdded(name);
              })
            }
            disabled={flow.busy}
          >
            {ctx.t('careAdd.add', { name })}
          </Button>
        ) : (
          <Button
            kind="secondary"
            onClick={() => {
              if (next) void flow.look(next);
            }}
            disabled={flow.busy || !ready || !next}
          >
            {ctx.t('careAdd.look')}
          </Button>
        )}
      </Row>
    </>
  );
}

/** 時刻（分まで。家族の決まりのとおりに入れる）。入れ終わるまでは空。 */
function TimeInput(props: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <input
      type="time"
      aria-label={props.label}
      className={field}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    />
  );
}
/** 時刻の欄に入った値が HH:MM か（途中や空は、まだ入っていない）。 */
const clockTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
/** 1 から max までの整数（締切の日数の選び肢）。 */
const upTo = (max: number) => Array.from({ length: max }, (_, i) => i + 1);

/** 頼める人：呼び名と、いつまでに頼むか（その日の何日前の 21 時まで）。 */
function HelperForm({ ctx, onAdded }: { ctx: Ctx; onAdded: (name: string) => void }) {
  const [id] = useState(() => newId('h'));
  const [name, setName] = useState('');
  const [days, setDays] = useState<(typeof HELPER_ASK_DAYS)[number]>();
  const trimmed = name.trim();
  const next =
    days === undefined
      ? undefined
      : (() => {
          const household = structuredClone(ctx.household);
          household.members.push({ id, kind: 'helper', name: trimmed, active: true });
          household.careOptions.push(helperAskOption(`opt-${id}`, id, days));
          return household;
        })();
  return (
    <>
      <Text quiet>{ctx.t('helperAsk.body')}</Text>
      <label className="flex flex-col gap-1.5">
        <span className="font-bold">{ctx.t('helperAsk.name')}</span>
        <input
          type="text"
          value={name}
          maxLength={20}
          placeholder={ctx.t('helperAsk.namePlaceholder')}
          onChange={(e) => setName(e.target.value)}
          className="min-h-12 rounded-xl border border-line bg-card px-3 text-lg"
        />
      </label>
      <label className="flex flex-wrap items-center gap-2">
        <span>{ctx.t('helperAsk.by')}</span>
        <select
          className={field}
          value={days ?? ''}
          onChange={(e) => setDays(HELPER_ASK_DAYS.find((d) => String(d) === e.target.value))}
        >
          <option value="" disabled>
            {ctx.t('helperAsk.choose')}
          </option>
          {HELPER_ASK_DAYS.map((d) => (
            <option key={d} value={d}>
              {ctx.t(`helperAsk.days.${d}`)}
            </option>
          ))}
        </select>
      </label>
      <AddFlow ctx={ctx} next={next} ready={trimmed.length > 0} name={trimmed} onAdded={onAdded} />
    </>
  );
}

/**
 * 学童：名前、申し込みの締切（前の週の曜日の時刻まで、か、その日の何日前の時刻まで）、一日利用で見てもらえる時間、
 * 一日の費用（円。0 も可）、お弁当が要るか（選ぶまで決めない）。家族が、子がこの学童に登録していて一日利用を
 * 申し込めると確かめた時だけ足せる。締切・時間・お弁当が分からない時は、学童に確かめてから足してもらう（初めの値で
 * 黙って記録しない）。
 */
function AfterSchoolForm({ ctx, onAdded }: { ctx: Ctx; onAdded: (name: string) => void }) {
  const [placeId] = useState(() => newId('p'));
  const [name, setName] = useState('');
  const [rule, setRule] = useState<'' | 'week' | 'days'>('');
  const [weekday, setWeekday] = useState<(typeof AFTER_SCHOOL_WEEKDAYS)[number]>();
  const [days, setDays] = useState<number>();
  const [at, setAt] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [yen, setYen] = useState('');
  const [bento, setBento] = useState<boolean>();
  const [enrolled, setEnrolled] = useState(false);
  const trimmed = name.trim();
  const amount = /^\d{1,6}$/.test(yen.trim()) ? Number(yen.trim()) : undefined;
  const hours =
    clockTime(from) && clockTime(to) && from < to ? { start: from, end: to } : undefined;
  const backwards = clockTime(from) && clockTime(to) && from >= to;
  const children = ctx.household.members.filter((m) => m.kind === 'child' && m.active);
  const childNames = new Intl.ListFormat(ctx.lang, { type: 'conjunction' }).format(
    children.map((m) => m.name),
  );
  const deadline: AfterSchoolDeadline | undefined = !clockTime(at)
    ? undefined
    : rule === 'week' && weekday !== undefined
      ? { type: 'weekdayOfPreviousWeek', weekday, at }
      : rule === 'days' && days !== undefined
        ? { type: 'daysBefore', days, at }
        : undefined;
  const next =
    deadline === undefined ||
    amount === undefined ||
    amount > 100_000 ||
    hours === undefined ||
    bento === undefined ||
    !enrolled
      ? undefined
      : (() => {
          const household = structuredClone(ctx.household);
          household.places.push({ id: placeId, kind: 'afterSchoolCare', name: trimmed, goods: [] });
          household.careOptions.push(
            afterSchoolOption(`opt-${placeId}`, placeId, deadline, amount, bento, hours),
          );
          return household;
        })();
  return (
    <>
      <Text quiet>{ctx.t('careAdd.afterSchool.body')}</Text>
      <label className="flex flex-col gap-1.5">
        <span className="font-bold">{ctx.t('careAdd.afterSchool.name')}</span>
        <input
          type="text"
          value={name}
          maxLength={20}
          placeholder={ctx.t('careAdd.afterSchool.namePlaceholder')}
          onChange={(e) => setName(e.target.value)}
          className="min-h-12 rounded-xl border border-line bg-card px-3 text-lg"
        />
      </label>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-1.5"
          checked={enrolled}
          onChange={(e) => setEnrolled(e.target.checked)}
        />
        <span>{ctx.t('careAdd.afterSchool.enrolled', { child: childNames })}</span>
      </label>
      <div className="flex flex-col gap-1.5">
        <span>{ctx.t('careAdd.afterSchool.hours')}</span>
        <div className="flex flex-wrap items-center gap-2">
          <TimeInput
            label={ctx.t('careAdd.afterSchool.hoursFrom')}
            value={from}
            onChange={setFrom}
          />
          <span aria-hidden="true">–</span>
          <TimeInput label={ctx.t('careAdd.afterSchool.hoursTo')} value={to} onChange={setTo} />
        </div>
        {backwards && (
          <span className="text-sm font-bold text-warn">
            {ctx.t('careAdd.afterSchool.hoursBackwards')}
          </span>
        )}
      </div>
      <label className="flex flex-wrap items-center gap-2">
        <span>{ctx.t('careAdd.afterSchool.by')}</span>
        <select
          className={field}
          value={rule}
          onChange={(e) =>
            setRule(e.target.value === 'week' || e.target.value === 'days' ? e.target.value : '')
          }
        >
          <option value="" disabled>
            {ctx.t('careAdd.choose')}
          </option>
          <option value="week">{ctx.t('careAdd.afterSchool.rule.week')}</option>
          <option value="days">{ctx.t('careAdd.afterSchool.rule.days')}</option>
        </select>
      </label>
      {rule !== '' && (
        <div className="flex flex-wrap items-center gap-2">
          {rule === 'week' ? (
            <select
              className={field}
              aria-label={ctx.t('careAdd.afterSchool.weekday')}
              value={weekday ?? ''}
              onChange={(e) =>
                setWeekday(AFTER_SCHOOL_WEEKDAYS.find((w) => String(w) === e.target.value))
              }
            >
              <option value="" disabled>
                {ctx.t('careAdd.afterSchool.weekday')}
              </option>
              {AFTER_SCHOOL_WEEKDAYS.map((w) => (
                <option key={w} value={w}>
                  {ctx.t('careAdd.afterSchool.weekdayOf', { weekday: weekdayLong(ctx, w) })}
                </option>
              ))}
            </select>
          ) : (
            <select
              className={field}
              aria-label={ctx.t('careAdd.afterSchool.daysLabel')}
              value={days ?? ''}
              onChange={(e) =>
                setDays(upTo(AFTER_SCHOOL_MAX_DAYS).find((d) => String(d) === e.target.value))
              }
            >
              <option value="" disabled>
                {ctx.t('careAdd.afterSchool.daysLabel')}
              </option>
              {upTo(AFTER_SCHOOL_MAX_DAYS).map((d) => (
                <option key={d} value={d}>
                  {ctx.t('careAdd.afterSchool.daysOf', { days: d })}
                </option>
              ))}
            </select>
          )}
          <TimeInput label={ctx.t('careAdd.at')} value={at} onChange={setAt} />
        </div>
      )}
      <label className="flex flex-wrap items-center gap-2">
        <span>{ctx.t('careAdd.afterSchool.yen')}</span>
        <input
          type="text"
          inputMode="numeric"
          value={yen}
          maxLength={6}
          placeholder={ctx.t('careAdd.afterSchool.yenPlaceholder')}
          onChange={(e) => setYen(e.target.value)}
          className={`${field} w-28`}
        />
        <span>{ctx.t('careAdd.afterSchool.yenUnit')}</span>
      </label>
      <fieldset className="flex flex-wrap items-center gap-3">
        <legend className="mb-1">{ctx.t('careAdd.afterSchool.bento')}</legend>
        {([true, false] as const).map((value) => (
          <label key={String(value)} className="flex min-h-11 items-center gap-1.5">
            <input
              type="radio"
              name={`bento-${placeId}`}
              checked={bento === value}
              onChange={() => setBento(value)}
            />
            {ctx.t(value ? 'careAdd.afterSchool.bentoYes' : 'careAdd.afterSchool.bentoNo')}
          </label>
        ))}
      </fieldset>
      <Text quiet>{ctx.t('careAdd.afterSchool.unknown')}</Text>
      <AddFlow ctx={ctx} next={next} ready={trimmed.length > 0} name={trimmed} onAdded={onAdded} />
    </>
  );
}

/**
 * 休み：だれが休むか（まだ休む手の無い大人）と、勤務先に伝える締切（その日の何営業日前の時刻まで）。営業日は土日・
 * 祝日を除いて数え、勤務先だけの休みは知らないので、そう書く。
 */
function LeaveForm({ ctx, onAdded }: { ctx: Ctx; onAdded: (name: string) => void }) {
  const [placeId] = useState(() => newId('p'));
  const [optionId] = useState(() => newId('opt-leave'));
  const adults = ctx.household.members.filter(
    (m) =>
      m.kind === 'adult' &&
      m.active &&
      !ctx.household.careOptions.some(
        (o) => o.kind === 'paidLeave' && o.steps[0]?.assigneeId === m.id,
      ),
  );
  const [adultId, setAdultId] = useState('');
  const [days, setDays] = useState<number>();
  const [at, setAt] = useState('');
  const adult = adults.find((m) => m.id === adultId);
  const title = adult ? ctx.t('option.paidLeave.title', { name: adult.name }) : '';
  const next =
    adult === undefined || days === undefined || !clockTime(at)
      ? undefined
      : (() => {
          const household = structuredClone(ctx.household);
          household.places.push({
            id: placeId,
            kind: 'workplace',
            name: ctx.t('careAdd.leave.workplace', { name: adult.name }),
            goods: [],
          });
          household.careOptions.push(leaveOption(optionId, adult.id, placeId, days, at));
          return household;
        })();
  if (adults.length === 0) return <Text quiet>{ctx.t('careAdd.leave.none')}</Text>;
  return (
    <>
      <Text quiet>{ctx.t('careAdd.leave.body')}</Text>
      <label className="flex flex-wrap items-center gap-2">
        <span>{ctx.t('careAdd.leave.who')}</span>
        <select className={field} value={adultId} onChange={(e) => setAdultId(e.target.value)}>
          <option value="" disabled>
            {ctx.t('careAdd.choose')}
          </option>
          {adults.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <span>{ctx.t('careAdd.leave.by')}</span>
        <select
          className={field}
          aria-label={ctx.t('careAdd.leave.daysLabel')}
          value={days ?? ''}
          onChange={(e) =>
            setDays(upTo(LEAVE_MAX_BUSINESS_DAYS).find((d) => String(d) === e.target.value))
          }
        >
          <option value="" disabled>
            {ctx.t('careAdd.leave.daysLabel')}
          </option>
          {upTo(LEAVE_MAX_BUSINESS_DAYS).map((d) => (
            <option key={d} value={d}>
              {ctx.t('careAdd.leave.daysOf', { days: d })}
            </option>
          ))}
        </select>
        <TimeInput label={ctx.t('careAdd.at')} value={at} onChange={setAt} />
      </div>
      <Text quiet>{ctx.t('careAdd.leave.businessDays')}</Text>
      <AddFlow ctx={ctx} next={next} ready={adult !== undefined} name={title} onAdded={onAdded} />
    </>
  );
}

/** 曜日の名前（1 が月曜）。2026-11-23 は月曜。 */
const weekdayLong = (ctx: Ctx, weekday: number) =>
  new Intl.DateTimeFormat(ctx.lang, { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2026, 10, 22 + weekday)),
  );
