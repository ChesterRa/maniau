// 「うちのこと」：まにあうが計算に使っている、家族と暮らしの情報（人・ふだんの一週間・場所と店・取れる手）。
// 見て、直して、保存の前に「この変更で変わること」を見る（サーバーが書き込まずに、書く時と同じ命令と同じ計算で
// 作った結果）。直せる範囲はサーバーが決める（成員の身元・場所・手の形は替えない）。
import type {
  CareOptionTemplate,
  DeadlineRule,
  Household,
  HouseholdPreview,
  Place,
  RoutineSegment,
} from '@maniau/core';
import { useState } from 'react';
import {
  type Ctx,
  day,
  dayTime,
  leaveText,
  nameOf,
  optionList,
  releasedTitle,
  taskTitle,
  timeOnly,
} from './screens';
import { Button, Card, Header, Label, Main, Row, Text, Title } from './ui';
import { WaysCard } from './ways';

type Mode = 'week' | 'places' | 'ways';
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const EDITABLE_KINDS = ['home', 'work', 'pickup', 'away'] as const;
const input =
  'min-h-11 rounded-xl border-[1.5px] border-btn-line bg-white px-2.5 text-base text-ink';

/** 曜日の名前（1 が月曜）。2026-11-23 は月曜。 */
const weekdayName = (ctx: Ctx, weekday: number) =>
  new Intl.DateTimeFormat(ctx.lang, { weekday: 'short', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2026, 10, 22 + weekday)),
  );

/** 同じ時間の曜日をまとめた営業時間（毎日・月・火…）。休みの曜日は書かない。 */
function hoursText(ctx: Ctx, place: Place): string {
  const periods = place.hours?.periods ?? [];
  if (periods.length === 0) return ctx.t('household.places.noHours');
  const groups = new Map<string, number[]>();
  for (const p of periods) {
    const key = `${p.open}–${p.close}`;
    groups.set(key, [...(groups.get(key) ?? []), p.weekday]);
  }
  return [...groups]
    .map(([range, days]) =>
      days.length === 7
        ? ctx.t('household.places.everyDay', { range })
        : `${days.map((d) => weekdayName(ctx, d)).join(ctx.t('household.places.daySeparator'))} ${range}`,
    )
    .join(ctx.t('list.separator'));
}

function sourceText(ctx: Ctx, place: Place): string | undefined {
  const hours = place.hours;
  if (!hours) return undefined;
  const from = ctx.t(`household.places.source.${hours.source}`);
  return hours.checkedAt
    ? ctx.t('household.places.checked', { from, when: dayTime(ctx, hours.checkedAt) })
    : from;
}

export function deadlineText(ctx: Ctx, rule: DeadlineRule): string {
  switch (rule.type) {
    case 'daysBefore':
      return ctx.t('household.ways.daysBefore', { days: rule.days, at: rule.at });
    case 'businessDaysBefore':
      return ctx.t('household.ways.businessDaysBefore', { days: rule.days, at: rule.at });
    case 'weekdayOfPreviousWeek':
      return ctx.t('household.ways.previousWeek', {
        weekday: weekdayName(ctx, rule.weekday),
        at: rule.at,
      });
    case 'onTheDay':
      return ctx.t('household.ways.onTheDay', { at: rule.at });
  }
}

/** 取れる手の名前（決める画面と同じ言葉）。 */
function wayTitle(ctx: Ctx, way: CareOptionTemplate): string {
  const name =
    way.kind === 'askHelper'
      ? nameOf(ctx.household, way.providerId)
      : nameOf(ctx.household, way.steps[0]?.assigneeId);
  return ctx.t(`${way.titleKey}.title`, { name });
}

function stepsText(ctx: Ctx, way: CareOptionTemplate): string {
  return way.steps
    .map((step) => {
      const title = ctx.t(step.titleKey, { name: nameOf(ctx.household, way.providerId) });
      return step.external ? ctx.t('household.ways.waitsReply', { title }) : title;
    })
    .join(' → ');
}

function costText(ctx: Ctx, way: CareOptionTemplate): string {
  const parts: string[] = [];
  if (way.cost.yen > 0) parts.push(ctx.t('household.ways.yen', { yen: way.cost.yen }));
  if (way.cost.leaveMinutes > 0) {
    parts.push(leaveText(ctx, way.cost.leaveMinutes));
  }
  if (way.cost.helperRequests > 0) parts.push(ctx.t('cost.helper'));
  return parts.join(ctx.t('list.separator'));
}

function segmentText(ctx: Ctx, segment: RoutineSegment): string {
  const range = `${segment.start}–${segment.end}`;
  const kind = ctx.t(`household.week.kind.${segment.kind}`);
  const where =
    segment.kind === 'commute'
      ? ctx.t('household.week.route', {
          from: nameOf(ctx.household, segment.fromId),
          to: nameOf(ctx.household, segment.toId),
        })
      : segment.placeId && segment.kind !== 'home'
        ? nameOf(ctx.household, segment.placeId)
        : '';
  return where ? `${range} ${kind}（${where}）` : `${range} ${kind}`;
}

/**
 * 「この変更で変わること」の行（何も変わらなければ一行）。after は直した後の家の情報（新しく足す場所の名前を、
 * 保存する前にも書けるように。無ければ今の家の情報）。
 */
export function householdPreviewLines(
  ctx: Ctx,
  preview: HouseholdPreview,
  after?: Household,
): string[] {
  const { changes } = preview;
  const lines: string[] = [];
  const placeName = (id: string) => (after ? nameOf(after, id) : '') || nameOf(ctx.household, id);
  const titleOf = (key: string) => {
    const task = ctx.plan.tasks.find((t) => t.key === key);
    return task ? taskTitle(ctx, task) : key;
  };
  const optionName = (key: string) => optionList(ctx, [key]) || ctx.t('household.preview.aWay');
  // 手配の時間（子の居場所が要る時間など）：同じ日の中なら終わりは時刻だけ。締切までに済ませる「すること」は、
  // 締切だけ（始まりは今で、要る時間ではない）。日だけの締切（その日の終わり。計画の時刻は家庭の時区で書いて
  // ある）は日だけ（書かれていない時刻を見せない）。
  const spanOf = (w: (typeof changes.windows)[number]) => (x: { start: string; end: string }) =>
    w.kind === 'need' && w.needShape === 'by'
      ? ctx.t('household.preview.window.by', {
          by: x.end.slice(11, 16) === '23:59' ? day(ctx, x.end) : dayTime(ctx, x.end),
        })
      : `${dayTime(ctx, x.start)}–${day(ctx, x.end) === day(ctx, x.start) ? timeOnly(ctx, x.end) : dayTime(ctx, x.end)}`;
  for (const w of changes.windows) {
    const span = spanOf(w);
    const what =
      w.kind === 'childCare'
        ? ctx.t('household.preview.window.childCare', {
            child: w.childId
              ? nameOf(ctx.household, w.childId)
              : ctx.t('household.preview.window.aChild'),
          })
        : w.kind === 'need'
          ? ctx.t('household.preview.window.need', { what: w.what ?? '' })
          : ctx.t('household.preview.window.purchase');
    if (w.before && w.after) {
      lines.push(
        ctx.t('household.preview.window.moved', {
          what,
          before: span(w.before),
          after: span(w.after),
        }),
      );
    } else if (w.after) {
      lines.push(ctx.t('household.preview.window.new', { what, when: span(w.after) }));
    } else if (w.before) {
      lines.push(ctx.t('household.preview.window.gone', { what, when: span(w.before) }));
    }
  }
  for (const d of changes.deadlines) {
    const name = optionName(d.optionKey);
    const { before, after } = d;
    if (!after) {
      lines.push(ctx.t('household.preview.wayGone', { name }));
      continue;
    }
    if (!before) {
      lines.push(ctx.t('household.preview.wayNew', { name }));
      continue;
    }
    // 直した後に決め時を計算できない手は、間に合わないとも間に合うとも言わない（確かめられないと書く）。
    // 計算できる手には、決め時がある（エンジンの決まり）。
    if (after.deadlineCertainty === 'undetermined') {
      lines.push(ctx.t('household.preview.deadlineUnknown', { name }));
    } else if (after.expired && !before.expired) {
      lines.push(ctx.t('household.preview.expires', { name }));
    } else if (before.expired && !after.expired) {
      lines.push(ctx.t('household.preview.reopens', { name }));
    } else if (before.decisionDeadline && after.decisionDeadline) {
      lines.push(
        ctx.t('household.preview.deadline', {
          name,
          before: dayTime(ctx, before.decisionDeadline),
          after: dayTime(ctx, after.decisionDeadline),
        }),
      );
    } else if (after.decisionDeadline) {
      lines.push(
        ctx.t('household.preview.deadlineKnown', {
          name,
          after: dayTime(ctx, after.decisionDeadline),
        }),
      );
    }
  }
  for (const step of changes.added) {
    const what = ctx.t(step.titleKey, step.titleParams);
    lines.push(
      step.start
        ? ctx.t('household.preview.added', { what, when: dayTime(ctx, step.start) })
        : ctx.t('household.preview.addedUntimed', { what }),
    );
  }
  for (const step of changes.removed) {
    lines.push(ctx.t('household.preview.removed', { what: titleOf(step.taskKey) }));
  }
  for (const m of changes.moved) {
    lines.push(
      ctx.t('household.preview.moved', {
        what: titleOf(m.taskKey),
        before: m.before.start ? dayTime(ctx, m.before.start) : '',
        after: m.after.start ? dayTime(ctx, m.after.start) : '',
      }),
    );
  }
  for (const key of changes.unplaced) {
    lines.push(ctx.t('household.preview.unplaced', { what: titleOf(key) }));
  }
  for (const key of changes.placed) {
    lines.push(ctx.t('household.preview.placed', { what: titleOf(key) }));
  }
  for (const r of changes.reassigned) {
    lines.push(
      ctx.t('household.preview.reassigned', {
        what: titleOf(r.taskKey),
        before: r.before ? nameOf(ctx.household, r.before) : ctx.t('household.preview.nobody'),
        after: r.after ? nameOf(ctx.household, r.after) : ctx.t('household.preview.nobody'),
      }),
    );
  }
  for (const r of changes.relocated) {
    lines.push(
      ctx.t('household.preview.relocated', {
        what: titleOf(r.taskKey),
        before: r.before ? placeName(r.before) : ctx.t('household.preview.noPlace'),
        after: r.after ? placeName(r.after) : ctx.t('household.preview.noPlace'),
      }),
    );
  }
  for (const key of changes.reconfirm) {
    lines.push(ctx.t('household.preview.reconfirm', { what: titleOf(key) }));
  }
  for (const key of changes.changed.filter((k) => !changes.reconfirm.includes(k))) {
    lines.push(ctx.t('household.preview.changed', { what: titleOf(key) }));
  }
  // 今の計画に見つからないだけの物（根拠のお知らせは残っている等）は、要らなくなったとは言わず、まだ要るかを
  // 引き受けた人に確かめてもらう（札・知らせと同じ）。
  for (const released of changes.released) {
    lines.push(
      ctx.t(
        released.reason === 'unconfirmed'
          ? 'household.preview.releasedCheck'
          : 'household.preview.released',
        {
          what: releasedTitle(ctx, released),
          name: nameOf(ctx.household, released.assigneeId),
        },
      ),
    );
  }
  // やり方の選びが古くなる「すること」（前の選びは当てない。家族に選び直してもらう）。
  for (const key of changes.rechoose) {
    const arrangement = ctx.plan.arrangements.find((a) => a.key === key);
    const what = ctx.plan.requirements.find((r) => r.key === arrangement?.requirementKey)?.what;
    lines.push(ctx.t('household.preview.rechoose', { what: what ?? '' }));
  }
  for (const request of changes.cancels) {
    lines.push(ctx.t('household.preview.cancel', { to: nameOf(ctx.household, request.to) }));
  }
  for (const request of changes.checks) {
    lines.push(ctx.t('household.preview.check', { to: nameOf(ctx.household, request.to) }));
  }
  if (changes.conflicts.length > 0) {
    lines.push(
      ctx.t('household.preview.conflict', { options: optionList(ctx, changes.conflicts) }),
    );
  }
  if (preview.issues.length > 0) {
    lines.push(ctx.t('household.preview.issues', { count: preview.issues.length }));
  }
  if (preview.unverified.length > 0) {
    lines.push(ctx.t('household.preview.unverified', { count: preview.unverified.length }));
  }
  return lines;
}

export function HouseholdScreen({ ctx }: { ctx: Ctx }) {
  const [mode, setMode] = useState<Mode>();
  const [draft, setDraft] = useState<Household>();
  const [shown, setShown] = useState<HouseholdPreview>();
  const [refused, setRefused] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [memberId, setMemberId] = useState<string>();
  const [weekday, setWeekday] = useState<number>(1);
  const household = draft ?? ctx.household;
  const people = household.members.filter((m) => m.active);
  const withRoutines = people.filter((m) => household.routines.some((d) => d.memberId === m.id));
  const editor = memberId ?? withRoutines[0]?.id;

  const edit = (next: Mode) => {
    setMode(next);
    setDraft(structuredClone(ctx.household));
    setShown(undefined);
    setRefused(undefined);
  };
  const change = (update: (h: Household) => void) => {
    const next = structuredClone(household);
    update(next);
    setDraft(next);
    setShown(undefined);
    setRefused(undefined);
  };
  const stop = () => {
    setMode(undefined);
    setDraft(undefined);
    setShown(undefined);
    setRefused(undefined);
  };
  const look = async () => {
    if (!draft || !ctx.previewHousehold) return;
    setBusy(true);
    const result = await ctx.previewHousehold(draft);
    setBusy(false);
    if (!result) setRefused('unavailable');
    else if ('refused' in result) setRefused(result.refused);
    else setShown(result.preview);
  };
  const save = async () => {
    if (!draft || !shown) return;
    setBusy(true);
    const result = await ctx.send({
      type: 'updateHousehold',
      household: draft,
      seen: { throughSeq: shown.throughSeq, changes: shown.seen },
    });
    setBusy(false);
    if (result.status === 'ok' || result.status === 'noop') stop();
    else setShown(undefined);
  };

  const day = household.routines.find((d) => d.memberId === editor && d.weekday === weekday);
  const stores = household.places.filter((p) => p.kind === 'store');
  const lines = shown ? householdPreviewLines(ctx, shown) : [];

  return (
    <>
      <Header title={ctx.t('household.title')} />
      <Main>
        <Text quiet>{ctx.t('household.intro')}</Text>

        <Card>
          <Label tone="sub">{ctx.t('household.people.label')}</Label>
          {people.map((m) => (
            <Text key={m.id}>
              {ctx.t(`household.people.kind.${m.kind}`, { name: m.name })}
              {m.grade ? ctx.t('household.people.grade', { grade: m.grade }) : ''}
              {m.clubEscort
                ? ctx.t('household.people.escort', {
                    rule: ctx.t(
                      `household.people.escortRule.${m.clubEscort.to ? 'to' : 'no'}${m.clubEscort.from ? 'From' : 'NoFrom'}`,
                    ),
                  })
                : ''}
            </Text>
          ))}
          <Text quiet>{ctx.t('household.people.used')}</Text>
        </Card>

        <Card>
          <Label tone="sub">{ctx.t('household.week.label')}</Label>
          {mode !== 'week' &&
            withRoutines.map((m) => {
              const days = household.routines
                .filter((d) => d.memberId === m.id)
                .sort((a, b) => a.weekday - b.weekday);
              // 一週間の区間は長いので、人ごとに畳む（場所と店・取れる手まで、すぐ届くように）。
              return (
                <details key={m.id} className="flex flex-col gap-1">
                  <summary className="min-h-11 cursor-pointer py-2 font-bold">
                    {ctx.t('household.week.summary', { name: m.name, count: days.length })}
                  </summary>
                  {days.map((d) => (
                    <Text key={d.weekday}>
                      {weekdayName(ctx, d.weekday)}：
                      {d.segments.map((s) => segmentText(ctx, s)).join('・')}
                    </Text>
                  ))}
                </details>
              );
            })}
          {mode === 'week' && (
            <div className="flex flex-col gap-2.5">
              <div className="flex flex-wrap gap-2">
                {withRoutines.map((m) => (
                  <Button
                    key={m.id}
                    kind={m.id === editor ? 'primary' : 'secondary'}
                    onClick={() => setMemberId(m.id)}
                  >
                    {m.name}
                  </Button>
                ))}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAYS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setWeekday(d)}
                    aria-pressed={d === weekday}
                    className={`min-h-11 min-w-11 rounded-xl border-[1.5px] px-2 font-bold ${d === weekday ? 'border-accent bg-accent text-white' : 'border-btn-line bg-white'}`}
                  >
                    {weekdayName(ctx, d)}
                  </button>
                ))}
              </div>
              {!day && <Text quiet>{ctx.t('household.week.noDay')}</Text>}
              {day?.segments.map((segment, index) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: 区間には ID が無く、画面は並びを替えない（時刻は直すたびに替わるので鍵にしない）
                  key={index}
                  className="flex flex-wrap items-center gap-2"
                >
                  <input
                    type="time"
                    aria-label={ctx.t('household.week.start')}
                    className={input}
                    value={segment.start}
                    onChange={(e) =>
                      change((h) => {
                        const segments = h.routines.find(
                          (r) => r.memberId === editor && r.weekday === weekday,
                        )?.segments;
                        const s = segments?.[index];
                        if (!s) return;
                        // 前の区間とつながっていれば、前の区間の終わりも動かす（切れ目を作らない）。
                        const previous = segments?.[index - 1];
                        if (previous && previous.end === s.start) previous.end = e.target.value;
                        s.start = e.target.value;
                      })
                    }
                  />
                  <span>–</span>
                  <input
                    type="time"
                    aria-label={ctx.t('household.week.end')}
                    className={input}
                    value={segment.end}
                    onChange={(e) =>
                      change((h) => {
                        const segments = h.routines.find(
                          (r) => r.memberId === editor && r.weekday === weekday,
                        )?.segments;
                        const s = segments?.[index];
                        if (!s) return;
                        // 次の区間とつながっていれば、次の区間の始まりも動かす（切れ目を作らない）。
                        const following = segments?.[index + 1];
                        if (following && following.start === s.end)
                          following.start = e.target.value;
                        s.end = e.target.value;
                      })
                    }
                  />
                  {segment.kind === 'commute' ? (
                    <span>{ctx.t('household.week.kind.commute')}</span>
                  ) : (
                    <select
                      aria-label={ctx.t('household.week.kindLabel')}
                      className={input}
                      value={segment.kind}
                      onChange={(e) =>
                        change((h) => {
                          const s = h.routines.find(
                            (r) => r.memberId === editor && r.weekday === weekday,
                          )?.segments[index];
                          if (!s) return;
                          const kind = e.target.value as RoutineSegment['kind'];
                          const homes = h.places.filter((p) => p.kind === 'home').map((p) => p.id);
                          const atHomePlace = s.placeId !== undefined && homes.includes(s.placeId);
                          // 過ごし方と場所を食い違わせない：「家」は家の場所にし、外出・迎えは家の場所を
                          // 外す（家で仕事をするのは、そのまま）。
                          if (kind === 'home') {
                            const home = homes[0];
                            if (home) s.placeId = home;
                            else delete s.placeId;
                          } else if ((kind === 'away' || kind === 'pickup') && atHomePlace) {
                            delete s.placeId;
                          }
                          s.kind = kind;
                        })
                      }
                    >
                      {EDITABLE_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {ctx.t(`household.week.kind.${k}`)}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              ))}
            </div>
          )}
          <Text quiet>{ctx.t('household.week.used')}</Text>
          {mode === undefined && (
            <Row>
              <Button kind="secondary" onClick={() => edit('week')}>
                {ctx.t('household.edit')}
              </Button>
            </Row>
          )}
        </Card>

        <Card>
          <Label tone="sub">{ctx.t('household.places.label')}</Label>
          {household.places
            .filter((p) => p.kind !== 'store')
            .map((p) => (
              <Text key={p.id}>
                {ctx.t(`household.places.kind.${p.kind}`)}：{p.name}
              </Text>
            ))}
          {stores.map((p) => (
            <div key={p.id} className="flex flex-col gap-1">
              <Text>
                {ctx.t('household.places.kind.store')}：{p.name}
              </Text>
              {mode !== 'places' && <Text quiet>{hoursText(ctx, p)}</Text>}
              {mode !== 'places' && sourceText(ctx, p) && <Text quiet>{sourceText(ctx, p)}</Text>}
              {mode === 'places' &&
                (p.hours?.periods ?? []).map((period, index) => (
                  <div key={period.weekday} className="flex flex-wrap items-center gap-2">
                    <span className="min-w-8">{weekdayName(ctx, period.weekday)}</span>
                    <input
                      type="time"
                      aria-label={ctx.t('household.places.open')}
                      className={input}
                      value={period.open}
                      onChange={(e) =>
                        change((h) => {
                          const target = h.places.find((x) => x.id === p.id)?.hours?.periods[index];
                          if (target) target.open = e.target.value;
                        })
                      }
                    />
                    <span>–</span>
                    <input
                      type="time"
                      aria-label={ctx.t('household.places.close')}
                      className={input}
                      value={period.close}
                      onChange={(e) =>
                        change((h) => {
                          const target = h.places.find((x) => x.id === p.id)?.hours?.periods[index];
                          if (target) target.close = e.target.value;
                        })
                      }
                    />
                  </div>
                ))}
            </div>
          ))}
          <Text quiet>{ctx.t('household.places.used')}</Text>
          {mode === undefined && stores.length > 0 && (
            <Row>
              <Button kind="secondary" onClick={() => edit('places')}>
                {ctx.t('household.edit')}
              </Button>
            </Row>
          )}
        </Card>

        <Card>
          <Label tone="sub">{ctx.t('household.ways.label')}</Label>
          {household.careOptions.map((way) => (
            <div key={way.id} className="flex flex-col gap-1">
              <Title>{wayTitle(ctx, way)}</Title>
              {mode !== 'ways' && <Text>{deadlineText(ctx, way.deadline)}</Text>}
              {mode === 'ways' && (
                <div className="flex flex-wrap items-center gap-2">
                  {way.deadline.type === 'daysBefore' ||
                  way.deadline.type === 'businessDaysBefore' ? (
                    <label className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min={1}
                        max={30}
                        className={`${input} w-20`}
                        value={way.deadline.days}
                        onChange={(e) =>
                          change((h) => {
                            const rule = h.careOptions.find((o) => o.id === way.id)?.deadline;
                            const days = Number.parseInt(e.target.value, 10);
                            if (
                              (rule?.type === 'daysBefore' ||
                                rule?.type === 'businessDaysBefore') &&
                              days > 0
                            ) {
                              rule.days = days;
                            }
                          })
                        }
                      />
                      {ctx.t(
                        way.deadline.type === 'daysBefore'
                          ? 'household.ways.daysUnit'
                          : 'household.ways.businessDaysUnit',
                      )}
                    </label>
                  ) : way.deadline.type === 'weekdayOfPreviousWeek' ? (
                    <select
                      aria-label={ctx.t('household.ways.weekday')}
                      className={input}
                      value={way.deadline.weekday}
                      onChange={(e) =>
                        change((h) => {
                          const rule = h.careOptions.find((o) => o.id === way.id)?.deadline;
                          if (rule?.type === 'weekdayOfPreviousWeek') {
                            rule.weekday = Number(e.target.value) as typeof rule.weekday;
                          }
                        })
                      }
                    >
                      {WEEKDAYS.map((d) => (
                        <option key={d} value={d}>
                          {ctx.t('household.ways.previousWeekDay', {
                            weekday: weekdayName(ctx, d),
                          })}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <input
                    type="time"
                    aria-label={ctx.t('household.ways.at')}
                    className={input}
                    value={way.deadline.at}
                    onChange={(e) =>
                      change((h) => {
                        const rule = h.careOptions.find((o) => o.id === way.id)?.deadline;
                        if (rule) rule.at = e.target.value;
                      })
                    }
                  />
                </div>
              )}
              <Text quiet>{stepsText(ctx, way)}</Text>
              {costText(ctx, way) && <Text quiet>{costText(ctx, way)}</Text>}
            </div>
          ))}
          <Text quiet>{ctx.t('household.ways.used')}</Text>
          {mode === undefined && (
            <Row>
              <Button kind="secondary" onClick={() => edit('ways')}>
                {ctx.t('household.edit')}
              </Button>
            </Row>
          )}
        </Card>

        {mode === undefined && <WaysCard ctx={ctx} />}

        {mode !== undefined && (
          <Card tone="accent">
            <Label tone="accent">{ctx.t('household.preview.label')}</Label>
            {refused && <Text>{ctx.t(`household.refused.${refusedKey(refused)}`)}</Text>}
            {shown && lines.length === 0 && <Text>{ctx.t('household.preview.none')}</Text>}
            {shown && lines.map((line) => <Text key={line}>{line}</Text>)}
            <Row>
              {shown ? (
                <Button onClick={() => void save()} disabled={busy}>
                  {ctx.t('household.save')}
                </Button>
              ) : (
                <Button onClick={() => void look()} disabled={busy || !ctx.previewHousehold}>
                  {ctx.t('household.look')}
                </Button>
              )}
              <Button kind="secondary" onClick={stop} disabled={busy}>
                {ctx.t('household.cancel')}
              </Button>
            </Row>
          </Card>
        )}
      </Main>
    </>
  );
}

/** サーバーが直しを断った理由の符号を、画面の言葉の鍵にする（知らない物は一つにまとめる）。 */
function refusedKey(reason: string): string {
  return [
    'householdInvalid',
    'routineGap',
    'routineDayMissing',
    'routinePlace',
    'hoursOvernight',
    'membersLocked',
    'placesLocked',
    'careOptionsLocked',
    'nameTaken',
    'unavailable',
  ].includes(reason)
    ? reason
    : 'other';
}
