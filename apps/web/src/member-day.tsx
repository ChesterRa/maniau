// その日だけの一日（「もし……なら」と、本当にそうする日）：ある大人のある日を、休み・その時間は家・外出・遅くなる
// で作り直し、書かない計算で何が変わるかを見せる（01-model「その日だけの一日」）。前提（だれ・どの日・どう変える
// か・時刻）は一番上に直せる欄で出し、言われていない前提（家の区間は子を見られる時間、前後はふだんどおり等）は
// 「仮に置いた前提」と分けて書く。区間はコード（core の draftDay）が作る。人・日・時刻が決まらない時は、計算せずに
// 欄を空のまま聞く。記録は別の「この日を記録する」だけ（見た計算の控えを付け、サーバーが家庭を押さえた中で計算し
// 直す）。
import {
  type DayChange,
  type DayDraftProblem,
  dayOf,
  draftDay,
  type Household,
  type MemberDayReply,
  type RoutineSegment,
  type Unavailable,
} from '@maniau/core';
import { useEffect, useState } from 'react';
import { localDate } from './format';
import { segmentText } from './household';
import { type Ctx, day, nameOf, type Route } from './screens';
import { Button, Card, Header, Label, Main, Row, Text, Title } from './ui';
import { Shown, useHouseholdSave } from './ways';

type Change = MemberDayReply['change'];
type Said = MemberDayReply['mode'];
/**
 * 一言から決められなかった欄（memberDayReply の problems。一日休みに時刻が付いていた時は offWithTime）。前提の画面で
 * 家族が欄を直すまで、計算しない。
 */
export type DayAsk = MemberDayReply['problems'][number] | 'offWithTime';
export type MemberDayRoute = Extract<Route, { name: 'memberDay' }>;

const CHANGES: readonly Change[] = ['off', 'home', 'away', 'late'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const input =
  'min-h-11 rounded-xl border-[1.5px] border-btn-line bg-white px-2.5 text-base text-ink';

interface Form {
  memberId: string;
  date: string;
  change?: Change;
  from: string;
  to: string;
}

/** 欄から、作り直す変え方（決まらなければ、足りない欄）。過ぎた日は計算しない。 */
function changeOf(form: Form, today: string): DayChange | 'person' | 'date' | 'change' | 'time' {
  if (!form.memberId) return 'person';
  if (!DATE.test(form.date) || form.date < today) return 'date';
  if (!form.change) return 'change';
  if (form.change === 'off') return { change: 'off' };
  if (form.change === 'late') return TIME.test(form.to) ? { change: 'late', to: form.to } : 'time';
  return TIME.test(form.from) && TIME.test(form.to) && form.from < form.to
    ? { change: form.change, from: form.from, to: form.to }
    : 'time';
}

/** その人のその日を、指定の区間に置き替えた家の情報（区間が無ければ、その日の例外を外す）。 */
function withDay(
  household: Household,
  memberId: string,
  date: string,
  segments: RoutineSegment[] | undefined,
): Household {
  const others = household.routineExceptions.filter(
    (e) => !(e.memberId === memberId && e.date === date),
  );
  return {
    ...household,
    routineExceptions: segments ? [...others, { memberId, date, segments }] : others,
  };
}

/** 手が離せない時間の直し：一つ足す（ID は押した時に作る）か、一つ外す。 */
type BusyEdit =
  | { kind: 'add'; id: string; from: string; to: string }
  | { kind: 'remove'; id: string };

/** 手が離せない時間を一つ足す・外した家の情報（場所の区間は変えない）。 */
function withBusy(household: Household, edit: BusyEdit, memberId: string, date: string): Household {
  const list = household.unavailable ?? [];
  const next: Unavailable[] =
    edit.kind === 'remove'
      ? list.filter((u) => u.id !== edit.id)
      : [...list, { id: edit.id, memberId, date, start: edit.from, end: edit.to }];
  return { ...household, unavailable: next };
}

function busyId(): string {
  try {
    return `u-${crypto.randomUUID()}`;
  } catch {
    return `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * 一言から読んだ一日を、前提の画面への道にする。決められなかった欄は持って行き、家族が直すまで計算しない。日と曜日が
 * 食い違う・過ぎた日は、読んだ日を入れずに聞く。一日休みに時刻が付いていた時は、変え方を入れずに、一日か、その時間
 * だけ家かを家族に選んでもらう（時刻は残す）。
 */
export function memberDayRoute(heard: MemberDayReply, text?: string): MemberDayRoute {
  const bad = new Set(heard.problems);
  const asks: DayAsk[] = heard.problems.map((p) =>
    p === 'time' && heard.change === 'off' ? 'offWithTime' : p,
  );
  const dated = heard.date !== undefined && !bad.has('date') && !bad.has('weekday');
  return {
    name: 'memberDay',
    said: heard.mode,
    ...(asks.includes('offWithTime') ? {} : { change: heard.change }),
    ...(heard.memberId ? { memberId: heard.memberId } : {}),
    ...(dated && heard.date ? { date: heard.date } : {}),
    ...(heard.from ? { from: heard.from } : {}),
    ...(heard.to ? { to: heard.to } : {}),
    ...(asks.length > 0 ? { asks } : {}),
    ...(text ? { text } : {}),
  };
}

/** 一言の答えの「大人のある一日」：読んだ前提を見せ、前提の画面へ案内する（ここでは何も記録しない）。 */
export function SayMemberDay({
  ctx,
  day: heard,
  text,
  onClear,
}: {
  ctx: Ctx;
  day: MemberDayReply;
  /** 読んだ一言の原文（前提の画面へ持って行き、読んだ前提と並べて見せる）。 */
  text?: string;
  onClear: () => void;
}) {
  const name = heard.memberId ? nameOf(ctx.household, heard.memberId) : '';
  const route = memberDayRoute(heard, text);
  const asks = route.asks ?? [];
  const when = route.date ? day(ctx, route.date) : '';
  return (
    <div className="flex flex-col gap-2">
      <Text quiet>{ctx.t(`memberDay.said.${heard.mode}`)}</Text>
      <Title>
        {ctx.t('memberDay.summary', {
          name: name || ctx.t('memberDay.unknownPerson'),
          day: when || ctx.t('memberDay.unknownDay'),
          change: changeText(ctx, heard.change, heard.from, heard.to),
        })}
      </Title>
      {asks.map((p) => (
        <Text key={p}>{ctx.t(`memberDay.ask.${p}`)}</Text>
      ))}
      <Button onClick={() => ctx.go(route)}>
        {ctx.t(asks.length > 0 ? 'memberDay.fill' : 'memberDay.compute')}
      </Button>
      <Button kind="secondary" onClick={onClear}>
        {ctx.t('say.cancel')}
      </Button>
    </div>
  );
}

/** 変え方の短い言葉（休み・9:00–17:00 は家・10:00–12:00 は外出・20:00 まで仕事）。 */
function changeText(ctx: Ctx, change: Change, from?: string, to?: string): string {
  if (change === 'off') return ctx.t('memberDay.change.off');
  if (change === 'late') {
    return to ? ctx.t('memberDay.text.late', { to }) : ctx.t('memberDay.change.late');
  }
  return from && to
    ? ctx.t(`memberDay.text.${change}`, { from, to })
    : ctx.t(`memberDay.change.${change}`);
}

export function MemberDayScreen({ ctx, route }: { ctx: Ctx; route: MemberDayRoute }) {
  const adults = ctx.household.members.filter((m) => m.kind === 'adult' && m.active);
  const [form, setForm] = useState<Form>(() => ({
    memberId: adults.some((m) => m.id === route.memberId) ? (route.memberId ?? '') : '',
    date: route.date ?? '',
    ...(route.change ? { change: route.change } : {}),
    from: route.from ?? '',
    to: route.to ?? '',
  }));
  // 記録してあるその日を、ふだんに戻す（前提の欄の代わりに、例外を外した家の情報を見る）。
  const [usual, setUsual] = useState(false);
  // 一言から決められなかった欄。家族がその欄を直すまで、計算しない。
  const [asks, setAsks] = useState<DayAsk[]>(route.asks ?? []);
  // 手が離せない時間の直し（その日の過ごし方の変え方とは別。押すまで、どちらも記録しない）。
  const [busyEdit, setBusyEdit] = useState<BusyEdit | undefined>();
  const [busyFrom, setBusyFrom] = useState('');
  const [busyTo, setBusyTo] = useState('');
  const flow = useHouseholdSave(ctx);
  const set = (patch: Partial<Form>) => {
    setUsual(false);
    setBusyEdit(undefined);
    setAsks((left) =>
      left.filter(
        (a) =>
          !(
            (a === 'person' && patch.memberId !== undefined) ||
            ((a === 'date' || a === 'weekday') && patch.date !== undefined) ||
            ((a === 'time' || a === 'offWithTime') &&
              (patch.change !== undefined || patch.from !== undefined || patch.to !== undefined))
          ),
      ),
    );
    setForm((f) => ({ ...f, ...patch }));
  };
  const today = localDate(ctx.now, ctx.tz);

  const recorded =
    form.memberId && DATE.test(form.date)
      ? ctx.household.routineExceptions.find(
          (e) => e.memberId === form.memberId && e.date === form.date,
        )
      : undefined;
  const wanted = asks[0] ?? changeOf(form, today);
  const draft =
    typeof wanted === 'object'
      ? draftDay(ctx.household, form.memberId, form.date, wanted)
      : undefined;
  const dayOk = Boolean(form.memberId) && DATE.test(form.date) && form.date >= today;
  const busyOfDay = dayOk
    ? (ctx.household.unavailable ?? [])
        .filter((u) => u.memberId === form.memberId && u.date === form.date)
        .sort((a, b) => a.start.localeCompare(b.start))
    : [];
  // 足す時間の確かめ（サーバーも同じ決まりで断る）：時刻の形、始まりが終わりより前、同じ人の同じ日の物と重ならない。
  const busyProblem: 'time' | 'overlap' | undefined =
    busyFrom === '' && busyTo === ''
      ? undefined
      : !TIME.test(busyFrom) || !TIME.test(busyTo) || busyFrom >= busyTo
        ? 'time'
        : busyOfDay.some((u) => u.start < busyTo && busyFrom < u.end)
          ? 'overlap'
          : undefined;
  const proposed: Household | undefined =
    busyEdit && dayOk
      ? withBusy(ctx.household, busyEdit, form.memberId, form.date)
      : usual
        ? withDay(ctx.household, form.memberId, form.date, undefined)
        : draft?.ok
          ? withDay(ctx.household, form.memberId, form.date, draft.segments)
          : undefined;
  const startBusy = (edit: BusyEdit) => {
    setUsual(false);
    setForm((f) => {
      const { change: _change, ...rest } = f;
      return { ...rest, from: '', to: '' };
    });
    setBusyEdit(edit);
  };
  const shown = proposed ? flow.shownFor(proposed) : undefined;
  const refused = proposed ? flow.refusedFor(proposed) : undefined;
  // 前提が決まったら、すぐに書かない計算を見る（計画が進んだら見直す）。押すまで何も書かない。
  const lookKey = proposed
    ? `${JSON.stringify([proposed.routineExceptions, proposed.unavailable ?? null])}|${ctx.plan.throughSeq}`
    : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: 前提と計画の版が替わった時だけ見る（flow は毎回新しい）
  useEffect(() => {
    if (proposed) void flow.look(proposed);
  }, [lookKey]);

  const usualDay =
    form.memberId && DATE.test(form.date)
      ? dayOf({ ...ctx.household, routineExceptions: [] }, form.memberId, form.date)
      : undefined;
  const save = async () => {
    if (!proposed) return;
    // 断られた時（見た後に計画が変わった等）は、見た物を捨てて計算し直す（古い計算のまま押させない）。
    if (await flow.save(proposed)) ctx.go({ name: 'today' });
    else void flow.look(proposed);
  };
  const said: Said | undefined = route.said;
  const problem: DayDraftProblem | undefined = draft && !draft.ok ? draft.problem : undefined;

  return (
    <>
      <Header
        back={
          said
            ? { label: ctx.t('nav.today'), onClick: () => ctx.go({ name: 'today' }) }
            : { label: ctx.t('nav.household'), onClick: () => ctx.go({ name: 'household' }) }
        }
        eyebrow={ctx.t(said ? `memberDay.eyebrow.${said}` : 'memberDay.eyebrow.edit')}
        title={ctx.t('memberDay.title')}
      />
      <Main>
        <Card tone="accent">
          <Label tone="accent">
            {ctx.t(said ? 'memberDay.premise.said' : 'memberDay.premise.edit')}
          </Label>
          {route.text && <Text quiet>{ctx.t('memberDay.heardText', { text: route.text })}</Text>}
          <label className="flex flex-col gap-1">
            <span className="text-sub">{ctx.t('memberDay.field.person')}</span>
            <select
              className={input}
              value={form.memberId}
              onChange={(e) => set({ memberId: e.target.value })}
            >
              <option value="">{ctx.t('memberDay.field.choose')}</option>
              {adults.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sub">{ctx.t('memberDay.field.date')}</span>
            <input
              type="date"
              className={input}
              value={form.date}
              onChange={(e) => set({ date: e.target.value })}
            />
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-sub">{ctx.t('memberDay.field.change')}</span>
            <div className="flex flex-wrap gap-1.5">
              {CHANGES.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-pressed={form.change === c}
                  onClick={() => set({ change: c })}
                  className={`min-h-11 rounded-xl border-[1.5px] px-3 font-bold ${form.change === c ? 'border-accent bg-accent text-white' : 'border-btn-line bg-white'}`}
                >
                  {ctx.t(`memberDay.change.${c}`)}
                </button>
              ))}
            </div>
          </div>
          {(form.change === 'home' || form.change === 'away') && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="time"
                aria-label={ctx.t('memberDay.field.from')}
                className={input}
                value={form.from}
                onChange={(e) => set({ from: e.target.value })}
              />
              <span>–</span>
              <input
                type="time"
                aria-label={ctx.t('memberDay.field.to')}
                className={input}
                value={form.to}
                onChange={(e) => set({ to: e.target.value })}
              />
            </div>
          )}
          {form.change === 'late' && (
            <label className="flex flex-col gap-1">
              <span className="text-sub">{ctx.t('memberDay.field.workEnds')}</span>
              <input
                type="time"
                className={input}
                value={form.to}
                onChange={(e) => set({ to: e.target.value })}
              />
            </label>
          )}
          {!usual && asks.slice(1).map((a) => <Text key={a}>{ctx.t(`memberDay.ask.${a}`)}</Text>)}
          {typeof wanted === 'string' && !usual && <Text>{ctx.t(`memberDay.ask.${wanted}`)}</Text>}
          {problem && !usual && <Text>{ctx.t(`memberDay.problem.${problem}`)}</Text>}
          {form.change && !usual && (
            <div className="flex flex-col gap-1 rounded-xl bg-paper px-3 py-2.5">
              <Label tone="warn">{ctx.t('memberDay.assumed.label')}</Label>
              <Text>{ctx.t(`memberDay.assumed.${form.change}`)}</Text>
              {said !== 'actual' && <Text quiet>{ctx.t('memberDay.assumed.notRecorded')}</Text>}
            </div>
          )}
        </Card>

        {usualDay && (
          <Card>
            <Label tone="sub">{ctx.t('memberDay.days.label')}</Label>
            <Text quiet>
              {ctx.t('memberDay.days.usual')}
              {usualDay.segments.map((s) => segmentText(ctx, s)).join('・')}
            </Text>
            {recorded && (
              <Text quiet>
                {ctx.t('memberDay.days.recorded')}
                {recorded.segments.map((s) => segmentText(ctx, s)).join('・')}
              </Text>
            )}
            {draft?.ok && !usual && (
              <Text>
                {ctx.t('memberDay.days.draft')}
                {draft.segments.map((s) => segmentText(ctx, s)).join('・')}
              </Text>
            )}
            {usual && <Text>{ctx.t('memberDay.days.backToUsual')}</Text>}
          </Card>
        )}

        {dayOk && (
          <Card>
            <Label tone="sub">{ctx.t('memberDay.busy.label')}</Label>
            <Text quiet>{ctx.t('memberDay.busy.about')}</Text>
            {busyOfDay.length === 0 && <Text quiet>{ctx.t('memberDay.busy.none')}</Text>}
            {busyOfDay.map((u) => (
              <div key={u.id} className="flex flex-wrap items-center gap-2">
                <span className="font-bold">
                  {ctx.t('memberDay.busy.item', { from: u.start, to: u.end })}
                </span>
                <Button kind="secondary" onClick={() => startBusy({ kind: 'remove', id: u.id })}>
                  {ctx.t('memberDay.busy.removeOne')}
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="time"
                aria-label={ctx.t('memberDay.busy.from')}
                className={input}
                value={busyFrom}
                onChange={(e) => {
                  // 見た後に時刻を変えたら、前に見た物では記録させない（もう一度「足して見る」）。
                  setBusyEdit(undefined);
                  setBusyFrom(e.target.value);
                }}
              />
              <span>–</span>
              <input
                type="time"
                aria-label={ctx.t('memberDay.busy.to')}
                className={input}
                value={busyTo}
                onChange={(e) => {
                  setBusyEdit(undefined);
                  setBusyTo(e.target.value);
                }}
              />
              <Button
                kind="secondary"
                disabled={busyFrom === '' || busyTo === '' || busyProblem !== undefined}
                onClick={() => startBusy({ kind: 'add', id: busyId(), from: busyFrom, to: busyTo })}
              >
                {ctx.t('memberDay.busy.add')}
              </Button>
            </div>
            {busyProblem && <Text>{ctx.t(`memberDay.busy.problem.${busyProblem}`)}</Text>}
          </Card>
        )}

        {proposed && (
          <Card>
            {busyEdit && (
              <Text>
                {busyEdit.kind === 'add'
                  ? ctx.t('memberDay.busy.adding', { from: busyEdit.from, to: busyEdit.to })
                  : ctx.t('memberDay.busy.removing', {
                      time: (() => {
                        const u = busyOfDay.find((x) => x.id === busyEdit.id);
                        return u ? ctx.t('memberDay.busy.item', { from: u.start, to: u.end }) : '';
                      })(),
                    })}
              </Text>
            )}
            {!shown && !refused && <Text quiet>{ctx.t('memberDay.loading')}</Text>}
            {refused === 'unavailable' && !flow.busy && (
              <Button kind="secondary" onClick={() => void flow.look(proposed)}>
                {ctx.t('memberDay.retry')}
              </Button>
            )}
            <Shown
              ctx={ctx}
              household={proposed}
              {...(shown ? { preview: shown } : {})}
              {...(refused ? { refused } : {})}
            />
            <Row>
              <Button onClick={() => void save()} disabled={!shown || flow.busy}>
                {ctx.t(
                  busyEdit
                    ? busyEdit.kind === 'add'
                      ? 'memberDay.busy.record'
                      : 'memberDay.busy.remove'
                    : usual
                      ? 'memberDay.restore'
                      : 'memberDay.record',
                )}
              </Button>
            </Row>
            <Text quiet>
              {ctx.t(busyEdit ? 'memberDay.busy.recordNote' : 'memberDay.recordNote')}
            </Text>
          </Card>
        )}

        {recorded && !usual && (
          <Button
            kind="secondary"
            onClick={() => {
              // 手が離せない時間の直しを見ていたら、それは捨てて、ふだんに戻すことを見る（押した方だけを記録する）。
              setBusyEdit(undefined);
              setUsual(true);
            }}
          >
            {ctx.t('memberDay.toUsual')}
          </Button>
        )}
      </Main>
    </>
  );
}

/** 「うち」のふだんの週の下：記録してあるその日だけの一日の一覧と、「この日だけ変える」。 */
export function RecordedDays({ ctx }: { ctx: Ctx }) {
  const days = [...ctx.household.routineExceptions].sort((a, b) =>
    a.date === b.date ? a.memberId.localeCompare(b.memberId) : a.date.localeCompare(b.date),
  );
  const busy = [...(ctx.household.unavailable ?? [])].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.memberId.localeCompare(b.memberId) ||
      a.start.localeCompare(b.start),
  );
  return (
    <div className="flex flex-col gap-1.5">
      <Title>{ctx.t('memberDay.list.label')}</Title>
      {days.length === 0 && busy.length === 0 && <Text quiet>{ctx.t('memberDay.list.none')}</Text>}
      {days.map((d) => (
        <button
          key={`${d.memberId}:${d.date}`}
          type="button"
          onClick={() => ctx.go({ name: 'memberDay', memberId: d.memberId, date: d.date })}
          className="min-h-11 rounded-xl border-[1.5px] border-btn-line bg-white px-3 py-2 text-left"
        >
          {ctx.t('memberDay.list.item', {
            day: day(ctx, d.date),
            name: nameOf(ctx.household, d.memberId),
            segments: d.segments.map((s) => segmentText(ctx, s)).join('・'),
          })}
        </button>
      ))}
      {/* 手が離せない時間（その日の画面で、一つずつ外せる）。 */}
      {busy.map((u) => (
        <button
          key={u.id}
          type="button"
          onClick={() => ctx.go({ name: 'memberDay', memberId: u.memberId, date: u.date })}
          className="min-h-11 rounded-xl border-[1.5px] border-btn-line bg-white px-3 py-2 text-left"
        >
          {ctx.t('memberDay.busy.list', {
            day: day(ctx, u.date),
            name: nameOf(ctx.household, u.memberId),
            from: u.start,
            to: u.end,
          })}
        </button>
      ))}
      <Row>
        <Button kind="secondary" onClick={() => ctx.go({ name: 'memberDay' })}>
          {ctx.t('memberDay.list.add')}
        </Button>
      </Row>
    </div>
  );
}
