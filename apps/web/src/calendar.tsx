// よていの月の暦（11/7 作り手 c97aed20：一か月が一目で見える日程表）。普通の暦との違いは、起きる事だけでなく、
// 子を見る手の欠け・手の決め時・返事待ち・まだ引き受けていない作業・条件しだいを、同じ日の上で分けて見せること。
// 行は週と同じ scheduleLines から取る（計画の写しを別に持たない）。印は色と文字の両方で示す。空の日は「登録された事が
// 無い」であって、空いているとは言わない。
import { useState } from 'react';
import { formatLongDay } from './format';
import {
  type Ctx,
  day,
  ScheduleLine,
  type ScheduleLines,
  type ScheduleTone,
  type WeekLine,
} from './screens';
import { Card, Label, Text } from './ui';

/** 印の並び（先ほど急ぐ）。一つの日に出す点は、この順で三つまで。 */
const TONES: ScheduleTone[] = [
  'attention',
  'deadline',
  'waiting',
  'proposed',
  'candidate',
  'settled',
  'event',
];
const DOT: Record<ScheduleTone, string> = {
  attention: 'bg-warn',
  deadline: 'bg-due',
  waiting: 'bg-wait',
  proposed: 'bg-sub',
  settled: 'bg-accent',
  candidate: 'border-[1.5px] border-sub bg-white',
  event: 'bg-ink',
};
/** 「この月の、まだ決まっていない事」に並べる印（まだ引き受けていない作業も入れる。11/7 見直しの指摘）。 */
const OPEN: ScheduleTone[] = ['attention', 'deadline', 'waiting', 'proposed', 'candidate'];

/** 週と月の切り替え。 */
export function ViewSwitch(props: {
  ctx: Ctx;
  view: 'week' | 'month';
  onView: (view: 'week' | 'month') => void;
}) {
  const item = (view: 'week' | 'month') => (
    <button
      type="button"
      aria-pressed={props.view === view}
      onClick={() => props.onView(view)}
      className={`min-h-11 flex-1 rounded-xl text-[15px] font-bold ${props.view === view ? 'bg-white text-ink shadow-[0_1px_3px_rgba(0,0,0,0.12)]' : 'text-sub'}`}
    >
      {props.ctx.t(view === 'week' ? 'calendar.week' : 'calendar.month')}
    </button>
  );
  return (
    <div className="flex gap-1 rounded-2xl bg-quote p-1">
      {item('week')}
      {item('month')}
    </div>
  );
}

/** 'YYYY-MM' の月の、日曜から始まる格子の日（前と後ろの月の日を含む）。 */
export function monthGrid(month: string): string[] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1));
  const inMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const weeks = Math.ceil((first.getUTCDay() + inMonth) / 7);
  return Array.from({ length: weeks * 7 }, (_, i) =>
    new Date(Date.UTC(y, m - 1, 1 - first.getUTCDay() + i)).toISOString().slice(0, 10),
  );
}

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
}

/** その日の行の印（急ぐ順に重ねず、種類ごとに一つ）。 */
export function tonesOf(lines: readonly WeekLine[]): ScheduleTone[] {
  const present = new Set(lines.map((line) => line.tone));
  return TONES.filter((tone) => present.has(tone));
}

export function MonthView({ ctx, schedule }: { ctx: Ctx; schedule: ScheduleLines }) {
  const { today, linesFor } = schedule;
  const [month, setMonth] = useState(today.slice(0, 7));
  const [selected, setSelected] = useState(today);
  const locale = ctx.lang === 'ja' ? 'ja-JP' : 'en-US';
  const cells = monthGrid(month);
  const lines = new Map(cells.map((date) => [date, linesFor(date)]));
  const inMonth = (date: string) => date.startsWith(month);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const monthLabel = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, 1)));
  // 2026-11-01 は日曜。曜日の見出しを言葉の形で（日・月… / Sun, Mon…）。
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(
      new Date(Date.UTC(2026, 10, 1 + i)),
    ),
  );
  const go = (by: number) => {
    const next = shiftMonth(month, by);
    setMonth(next);
    // きょうの月に戻ればきょうを、ほかの月では最初に事のある日（無ければ一日）を開く。
    const days = monthGrid(next).filter((date) => date.startsWith(next));
    setSelected(
      next === today.slice(0, 7)
        ? today
        : (days.find((date) => linesFor(date).length > 0) ?? `${next}-01`),
    );
  };
  const selectedLines = lines.get(selected) ?? linesFor(selected);
  // この月の、まだ決まっていない事（きょうから後だけ。過ぎた日は並べない）。
  const open = cells
    .filter((date) => inMonth(date) && date >= today)
    .flatMap((date) =>
      (lines.get(date) ?? [])
        .filter((line) => OPEN.includes(line.tone))
        .map((line) => ({ date, line })),
    );
  return (
    <>
      <Card className="gap-2 px-2 py-3">
        <div className="flex items-center justify-between px-1">
          <button
            type="button"
            aria-label={ctx.t('calendar.prev')}
            onClick={() => go(-1)}
            className="flex size-11 items-center justify-center rounded-full text-2xl text-sub"
          >
            ‹
          </button>
          <span className="font-round text-lg font-bold">{monthLabel}</span>
          <button
            type="button"
            aria-label={ctx.t('calendar.next')}
            onClick={() => go(1)}
            className="flex size-11 items-center justify-center rounded-full text-2xl text-sub"
          >
            ›
          </button>
        </div>
        {/* 印の見方は格子の上に置く（携帯の初めの画面で、格子の下まで送らなくても読めるように）。 */}
        <ul className="flex flex-wrap gap-x-3 gap-y-1 px-1 text-xs text-sub">
          {TONES.map((tone) => (
            <li key={tone} className="flex items-center gap-1">
              <span className={`size-2.5 flex-none rounded-full ${DOT[tone]}`} />
              {ctx.t(`calendar.tone.${tone}`)}
            </li>
          ))}
          <li className="flex items-center gap-1">
            <span className="size-3 flex-none rounded-full border-[1.5px] border-dashed border-ink" />
            {ctx.t('calendar.conditional')}
          </li>
        </ul>
        <div className="grid grid-cols-7 text-center text-xs text-sub">
          {weekdays.map((w) => (
            <span key={w} className="py-1">
              {w}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-y-1">
          {cells.map((date) => {
            const dayLines = lines.get(date) ?? [];
            const tones = tonesOf(dayLines);
            // 条件しだいの事がある日は、日の数字を点線で囲む（引き受け・返事の色とは別に、いつも見せる）。
            const conditional = dayLines.some((line) => line.conditional);
            const isToday = date === today;
            const isSelected = date === selected;
            return (
              <button
                key={date}
                type="button"
                aria-pressed={isSelected}
                aria-label={ctx.t('calendar.cell', {
                  day: day(ctx, date),
                  count: dayLines.length,
                  marks: [
                    ...tones.map((tone) => ctx.t(`calendar.tone.${tone}`)),
                    ...(conditional ? [ctx.t('calendar.conditional')] : []),
                  ].join('・'),
                })}
                onClick={() => setSelected(date)}
                className={`flex min-h-14 flex-col items-center gap-0.5 rounded-xl pt-1 ${isSelected ? 'bg-accent-soft' : ''} ${inMonth(date) ? '' : 'opacity-40'}`}
              >
                <span
                  className={`flex size-7 items-center justify-center rounded-full font-round text-[15px] tabular-nums ${isToday ? 'bg-accent font-bold text-white' : ''} ${conditional ? 'border-[1.5px] border-dashed border-ink' : ''}`}
                >
                  {Number(date.slice(8))}
                </span>
                <span className="flex h-2.5 items-center gap-0.5">
                  {tones.slice(0, 3).map((tone) => (
                    <span key={tone} className={`size-2 rounded-full ${DOT[tone]}`} />
                  ))}
                </span>
                {dayLines.length > 0 && (
                  <span className="text-[11px] leading-none text-sub tabular-nums">
                    {dayLines.length}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </Card>
      <Card className="gap-0.5">
        <Label tone="sub">{formatLongDay(selected, ctx.lang, ctx.tz)}</Label>
        {selectedLines.length === 0 ? (
          <Text quiet>{ctx.t('calendar.dayEmpty')}</Text>
        ) : (
          selectedLines.map((line) => <ScheduleLine key={line.key} ctx={ctx} line={line} />)
        )}
      </Card>
      <Card className="gap-0.5">
        <Label tone="warn">{ctx.t('calendar.openTitle', { month: monthLabel })}</Label>
        {open.length === 0 ? (
          <Text quiet>{ctx.t('calendar.openEmpty')}</Text>
        ) : (
          open.map(({ date, line }) => (
            <div key={`${date}:${line.key}`} className="flex gap-3">
              <button
                type="button"
                onClick={() => setSelected(date)}
                className="min-h-10 w-20 flex-none pt-1 text-left text-sm font-bold whitespace-nowrap text-accent underline"
              >
                {day(ctx, date)}
              </button>
              <span className="min-w-0 flex-1">
                <ScheduleLine ctx={ctx} line={line} />
              </span>
            </div>
          ))
        )}
      </Card>
    </>
  );
}
