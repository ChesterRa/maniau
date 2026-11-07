// お知らせの原文と読み取った日を見比べて直す。保存の前にはサーバーの計算で変わる事を見る。
import {
  formatDateTime,
  type Item,
  isValidLocalDate,
  localDateOf,
  localTimeOf,
  type SaveablePreview,
  type Source,
  toEpochMinutes,
  weekdayOf,
  zonedToEpochMinutes,
} from '@maniau/core';
import { useState } from 'react';
import { formatDay } from './format';
import { PreviewBlock, StalePreview, usePreviewSave } from './need';
import type { Ctx } from './screens';
import { Button, Label, Row, Text } from './ui';
import { UnanchoredNote } from './written-on';

/**
 * 「あしたまでに」のように、日付と締切を同じ「あした」から決めた事項の、日付を直した後の締切（同じ日へ動かし、
 * 時刻はそのまま）。締切を古い日に残すと、計画は古い締切を使う。そうでない事項・日付を変えない時は無し。
 */
function movedDeadline(ctx: Ctx, item: Item, date: string): string | undefined {
  const { relativeDay, date: before, deadline } = item.interpretation;
  if (relativeDay === undefined || before === undefined || deadline === undefined) return undefined;
  if (!isValidLocalDate(date) || date === before) return undefined;
  const at = toEpochMinutes(deadline);
  if (localDateOf(at, ctx.tz) !== before) return undefined;
  return formatDateTime(zonedToEpochMinutes(date, localTimeOf(at, ctx.tz), ctx.tz), ctx.tz);
}

const input =
  'min-h-11 rounded-xl border-[1.5px] border-btn-line bg-white px-2.5 text-base text-ink';

/**
 * 見た変化が、今の画面の計画と違う版の物なら、見せ直す（もう一人の変更の後に、前の画面の入力で記録しない。
 * ほかの画面と同じ。11/7 見直しの指摘）。
 */
const isStale = (ctx: Ctx, shown?: { throughSeq: number }) =>
  shown !== undefined && shown.throughSeq !== ctx.plan.throughSeq;

function DateEdit({
  ctx,
  item,
  live,
  trusted,
  links,
}: {
  ctx: Ctx;
  item: Item;
  live: boolean;
  trusted: boolean;
  links: { label?: string; value: string }[];
}) {
  const [date, setDate] = useState(item.interpretation.date ?? '');
  // 欄を開いた時の日付。その後にもう一人が同じ事項の日付を直したら、前の日付を直しとして送らない（入れ直す。
  // 時刻・名前の直しと同じ。11/7 見直しの指摘）。
  const [opened, setOpened] = useState(item.interpretation.date);
  const moved = opened !== item.interpretation.date;
  const flow = usePreviewSave(ctx);
  const deadline = movedDeadline(ctx, item, date);
  const command: SaveablePreview = {
    type: 'correctItem',
    itemId: item.id,
    interpretation: { date, ...(deadline === undefined ? {} : { deadline }) },
  };
  const shown = flow.shownFor(command);
  const refused = flow.refusedFor(command);
  const stale = isStale(ctx, shown);
  const linked = links.length > 0 && date !== item.interpretation.date;
  const wrongWeekday =
    isValidLocalDate(date) &&
    item.interpretation.writtenWeekday !== undefined &&
    weekdayOf(date) !== item.interpretation.writtenWeekday;
  const valid =
    isValidLocalDate(date) &&
    (date !== item.interpretation.date || !trusted) &&
    !linked &&
    !wrongWeekday &&
    !moved;
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-paper px-3 py-3">
      <Text>{item.written}</Text>
      <Text quiet>
        {item.interpretation.date
          ? ctx.t('sourceFix.date.read', {
              date: formatDay(item.interpretation.date, ctx.lang, ctx.tz),
            })
          : ctx.t('sourceFix.date.missing')}
      </Text>
      {!live && <Text quiet>{ctx.t('sourceFix.date.inactive')}</Text>}
      {!trusted && <Text>{ctx.t('sourceFix.date.unconfirmed')}</Text>}
      {moved && (
        <div className="flex flex-col gap-2" role="status">
          <Text>{ctx.t('sourceFix.item.moved')}</Text>
          <Button
            kind="secondary"
            onClick={() => {
              setDate(item.interpretation.date ?? '');
              setOpened(item.interpretation.date);
            }}
          >
            {ctx.t('sourceFix.item.reload')}
          </Button>
        </div>
      )}
      {wrongWeekday && (
        <div role="status">
          <Text>{ctx.t('sourceFix.date.weekdayMismatch')}</Text>
          <Text>
            {ctx.t(
              ctx.read ? 'sourceFix.date.weekdayHelp' : 'sourceFix.date.weekdayHelpUnavailable',
            )}
          </Text>
        </div>
      )}
      {linked && (
        <div className="flex flex-col gap-1" role="status">
          {links.map((link, index) => (
            <Text key={link.label ?? index}>
              {ctx.t('sourceFix.date.link', {
                label: link.label ?? ctx.t('sourceFix.date.unknownCondition'),
                date: formatDay(link.value, ctx.lang, ctx.tz),
              })}
            </Text>
          ))}
          <Text>
            {ctx.t(ctx.read ? 'sourceFix.date.linkHelp' : 'sourceFix.date.linkHelpUnavailable')}
          </Text>
        </div>
      )}
      <label className="flex flex-col gap-1">
        {ctx.t('sourceFix.date.label')}
        <input
          className={input}
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>
      {refused === 'legacyRequestUnclear' ? (
        <Text>{ctx.t('sourceFix.date.legacy')}</Text>
      ) : refused === 'dateLinkedCondition' ? (
        <div className="flex flex-col gap-2" role="status">
          <Text>{ctx.t('sourceFix.date.changed')}</Text>
          {ctx.refresh && (
            <Button kind="secondary" onClick={ctx.refresh}>
              {ctx.t('sourceFix.date.refresh')}
            </Button>
          )}
        </div>
      ) : stale ? (
        <StalePreview ctx={ctx} />
      ) : (
        <PreviewBlock
          ctx={ctx}
          {...(shown ? { preview: shown } : {})}
          {...(refused ? { refused } : {})}
        />
      )}
      <Row>
        {shown && !stale ? (
          <Button disabled={flow.busy || !valid} onClick={() => void flow.save(command)}>
            {ctx.t('sourceFix.date.save')}
          </Button>
        ) : (
          <Button
            disabled={flow.busy || !valid || !ctx.previewChange}
            onClick={() => void flow.look(command)}
          >
            {ctx.t('sourceFix.look')}
          </Button>
        )}
      </Row>
    </div>
  );
}

function DiscardEdit({ ctx, source }: { ctx: Ctx; source: Source }) {
  const flow = usePreviewSave(ctx);
  const [reason, setReason] = useState<'misfiled' | 'misread'>();
  const command: SaveablePreview = {
    type: 'discardSource',
    sourceId: source.id,
    reason: reason ?? 'misfiled',
  };
  const shown = flow.shownFor(command);
  const refused = flow.refusedFor(command);
  const stale = isStale(ctx, shown);
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-paper px-3 py-3">
      <Text>{ctx.t('sourceFix.discard.body')}</Text>
      <Text>{ctx.t('sourceFix.discard.noUndo')}</Text>
      <Text>
        {ctx.t(ctx.read ? 'sourceFix.discard.readd' : 'sourceFix.discard.readdUnavailable')}
      </Text>
      <fieldset className="flex flex-col gap-2">
        <legend>{ctx.t('sourceFix.discard.reason')}</legend>
        {(['misfiled', 'misread'] as const).map((choice) => (
          <label key={choice} className="flex min-h-11 items-center gap-2">
            <input
              type="radio"
              name={`discard-${source.id}`}
              value={choice}
              checked={reason === choice}
              onChange={() => setReason(choice)}
            />
            {ctx.t(`sourceFix.discard.${choice}`)}
          </label>
        ))}
      </fieldset>
      {refused === 'legacyRequestUnclear' ? (
        <Text>{ctx.t('sourceFix.discard.legacy')}</Text>
      ) : stale ? (
        <StalePreview ctx={ctx} />
      ) : (
        <PreviewBlock
          ctx={ctx}
          {...(shown ? { preview: shown } : {})}
          {...(refused ? { refused } : {})}
        />
      )}
      <Row>
        {shown && !stale ? (
          <Button disabled={flow.busy} onClick={() => void flow.save(command)}>
            {ctx.t('sourceFix.discard.save')}
          </Button>
        ) : (
          <Button
            kind="secondary"
            disabled={flow.busy || !reason || !ctx.previewChange}
            onClick={() => void flow.look(command)}
          >
            {ctx.t('sourceFix.look')}
          </Button>
        )}
      </Row>
    </div>
  );
}

/** 原文を残したまま、読み取った日を直す・入れ間違えたお知らせを外す。 */
/** 時刻の形（HH:MM）。 */
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 読み取った時刻と名前を直す（11/7 体検：画面が日付の直ししか出していなかった。サーバーはどの欄の直しも受ける）。
 * 日付の直しは上の DateEdit（条件や曜日の確かめがあるので分ける）。保存の前にサーバーの計算で変わる事を見る。
 */
function TimeEdit({ ctx, item }: { ctx: Ctx; item: Item }) {
  const read = item.interpretation;
  const [start, setStart] = useState(read.startTime ?? '');
  const [end, setEnd] = useState(read.endTime ?? '');
  const [what, setWhat] = useState(read.what ?? '');
  // 欄を開いた時の読み取り。その後にもう一人が同じ事項を直したら、前の値を「直した」として送らない（入れ直す）。
  const [opened, setOpened] = useState(read);
  const moved =
    opened.startTime !== read.startTime ||
    opened.endTime !== read.endTime ||
    opened.what !== read.what;
  const reload = () => {
    setStart(read.startTime ?? '');
    setEnd(read.endTime ?? '');
    setWhat(read.what ?? '');
    setOpened(read);
  };
  const flow = usePreviewSave(ctx);
  const timed = item.kind === 'event' || item.kind === 'test';
  const changed: { startTime?: string; endTime?: string; what?: string } = {};
  if (timed && start !== (read.startTime ?? '') && start !== '') changed.startTime = start;
  if (timed && end !== (read.endTime ?? '') && end !== '') changed.endTime = end;
  if (what.trim() !== '' && what.trim() !== (read.what ?? '')) changed.what = what.trim();
  const command: SaveablePreview = {
    type: 'correctItem',
    itemId: item.id,
    interpretation: changed,
  };
  const shown = flow.shownFor(command);
  const refused = flow.refusedFor(command);
  const stale = isStale(ctx, shown);
  const startOk = start === '' || TIME.test(start);
  const endOk = end === '' || TIME.test(end);
  // 読み取った欄を空にはできない（送るのは入れた値だけで、空にした欄は前の値のまま残る。画面と記録を食い違わせ
  // ない。11/7 見直しの指摘）。順の確かめは、記録される値（入れた値、無ければ前の値）で。
  const cleared =
    (timed && read.startTime !== undefined && start === '') ||
    (timed && read.endTime !== undefined && end === '') ||
    (read.what !== undefined && what.trim() === '');
  const from = start || read.startTime || '';
  const to = end || read.endTime || '';
  const ordered = !(from && to && TIME.test(from) && TIME.test(to)) || to > from;
  const valid =
    Object.keys(changed).length > 0 && startOk && endOk && ordered && !cleared && !moved;
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-paper px-3 py-3">
      <Text>{item.written}</Text>
      <Text quiet>
        {ctx.t('sourceFix.item.read', { what: read.what ?? item.written })}
        {timed &&
          ` ${
            read.startTime
              ? ctx.t('sourceFix.item.readTime', {
                  start: read.startTime,
                  end: read.endTime ?? '',
                })
              : ctx.t('sourceFix.item.noTime')
          }`}
      </Text>
      <label className="flex flex-col gap-1">
        {ctx.t('sourceFix.item.nameLabel')}
        <input className={input} value={what} onChange={(e) => setWhat(e.target.value)} />
      </label>
      {timed && (
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1">
            {ctx.t('sourceFix.item.startLabel')}
            <input
              className={input}
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            {ctx.t('sourceFix.item.endLabel')}
            <input
              className={input}
              type="time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
        </div>
      )}
      {moved && (
        <div className="flex flex-col gap-2" role="status">
          <Text>{ctx.t('sourceFix.item.moved')}</Text>
          <Button kind="secondary" onClick={reload}>
            {ctx.t('sourceFix.item.reload')}
          </Button>
        </div>
      )}
      {cleared && <Text>{ctx.t('sourceFix.item.noClear')}</Text>}
      {!ordered && <Text>{ctx.t('sourceFix.item.badOrder')}</Text>}
      {stale ? (
        <StalePreview ctx={ctx} />
      ) : (
        <PreviewBlock
          ctx={ctx}
          {...(shown ? { preview: shown } : {})}
          {...(refused ? { refused } : {})}
        />
      )}
      <Row>
        {shown && !stale ? (
          <Button disabled={flow.busy || !valid} onClick={() => void flow.save(command)}>
            {ctx.t('sourceFix.item.save')}
          </Button>
        ) : (
          <Button
            disabled={flow.busy || !valid || !ctx.previewChange}
            onClick={() => void flow.look(command)}
          >
            {ctx.t('sourceFix.look')}
          </Button>
        )}
      </Row>
    </div>
  );
}

/**
 * 読み取った事項を一件だけ計画から外す（うちには関係ない・読み取りが違う）。お知らせごと外すのとは別。行事が取り消さ
 * れたとは扱わない。保存の前に変わる事（要らなくなる引き受け・取り消しの連絡など）を見る。
 */
function ItemDismiss({ ctx, item }: { ctx: Ctx; item: Item }) {
  const [reason, setReason] = useState<'notOurs' | 'misread'>('notOurs');
  const flow = usePreviewSave(ctx);
  const command: SaveablePreview = { type: 'dismissItem', itemId: item.id, reason };
  const shown = flow.shownFor(command);
  const refused = flow.refusedFor(command);
  const stale = isStale(ctx, shown);
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-paper px-3 py-3">
      <Text>{item.written}</Text>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-bold text-sub">{ctx.t('sourceFix.item.reason')}</legend>
        {(['notOurs', 'misread'] as const).map((value) => (
          <label key={value} className="flex min-h-11 items-center gap-2">
            <input
              type="radio"
              name={`dismiss-${item.id}`}
              value={value}
              className="size-5 accent-accent"
              checked={reason === value}
              onChange={() => setReason(value)}
            />
            {ctx.t(`sourceFix.item.reasons.${value}`)}
          </label>
        ))}
      </fieldset>
      <Text quiet>{ctx.t('sourceFix.item.dismissNote')}</Text>
      {stale ? (
        <StalePreview ctx={ctx} />
      ) : (
        <PreviewBlock
          ctx={ctx}
          {...(shown ? { preview: shown } : {})}
          {...(refused ? { refused } : {})}
        />
      )}
      <Row>
        {shown && !stale ? (
          <Button disabled={flow.busy} onClick={() => void flow.save(command)}>
            {ctx.t('sourceFix.item.dismissSave')}
          </Button>
        ) : (
          <Button
            disabled={flow.busy || !ctx.previewChange}
            onClick={() => void flow.look(command)}
          >
            {ctx.t('sourceFix.look')}
          </Button>
        )}
      </Row>
    </div>
  );
}

export function SourceEdits({ ctx, source }: { ctx: Ctx; source: Source }) {
  const excluded = ctx.excludedSources?.get(source.id);
  // 家族が直接書いた「すること」は読み取りではない。専用の画面から直す・要らなくする。
  if (!excluded && !ctx.readings.some((reading) => reading.sourceId === source.id)) return null;
  // 日付を直す：日付の欄のある事項と、日の要る種類（行事・日の変更・テスト）。出さない物（締切はここではまだ
  // 直せないと書く）：
  // - 締切の日から置く締切の事項（日付の欄を直しても、よていは動かない）。ただし「あしたまでに」のように日付と締切を
  //   同じ「あした」から決め、同じ日にある物は、日付を直すと締切も同じ日へ動く（movedDeadline）ので出す（書かれた日の
  //   読み違いを、ここで直せるように）。
  // - まだ確かめていない事項で、締切が日付と別の日の物（持ち物・提出物も）。日付を確かめても、締切の日を確かめた
  //   ことにはならない（「12月7日の行事の出欠票は、あしたまでに」。11/7 見直しの反例）。サーバーも同じ直しを断る。
  const dueOnly = (entry: (typeof ctx.items)[number]) => {
    const { kind, interpretation: i } = entry.item;
    if (i.deadline === undefined) return false;
    const due = localDateOf(toEpochMinutes(i.deadline), ctx.tz);
    if (kind === 'deadline') return !(i.relativeDay !== undefined && due === i.date);
    return !entry.trusted && due !== i.date;
  };
  const editable = ctx.items.filter(
    (entry) =>
      entry.item.sourceId === source.id &&
      entry.item.kind !== 'need' &&
      !dueOnly(entry) &&
      (entry.item.interpretation.date !== undefined ||
        ['event', 'dayChange', 'test'].includes(entry.item.kind)),
  );
  const deadlines = ctx.items.filter(
    (entry) => entry.item.sourceId === source.id && entry.live && dueOnly(entry),
  );
  // 時刻・名前の直しと一件だけ外すのは、今の計画に入っている事項（日付の無い持ち物・締切も。11/7 見直しの指摘）。
  // 条件が合わない事項の日付は、読み違いかもしれないので日付の欄に残す。外した一件は、見せる物に来ない。
  const current = ctx.items.filter(
    (entry) => entry.item.sourceId === source.id && entry.item.kind !== 'need' && entry.live,
  );
  // まだ確かめていない事項（推定・食い違い・読み直した後）は、時刻・名前の直しに出さない。直しは事項を確かめた
  // ことにするので、確かめていない日付まで確かにしてしまう（「あした」を入れた日から数えた日付など。11/7 見直しの
  // 反例）。日付を確かめてから（同じ日のままでも保存できる）直してもらう。一件だけ外すことはできる。
  const unconfirmed = current.filter(({ trusted }) => !trusted);
  // 書かれた日が分からないまま「あした」「きょう」を入れた日から数え、まだ確かめていない事項の訳（同じ言い方・
  // 同じ日の物は一つにまとめる）。日付を直す所の上に、開かなくても見えるように出す。
  const unanchored = [
    ...new Map(
      editable
        .filter(
          ({ item, trusted }) =>
            !trusted && item.interpretation.relativeDayFromReceived !== undefined,
        )
        .map(({ item }) => [
          `${item.interpretation.relativeDay}:${item.interpretation.relativeDayFromReceived}`,
          item,
        ]),
    ).values(),
  ];
  return (
    <div className="flex flex-col gap-2">
      {excluded && <Text>{ctx.t(`sourceFix.discard.excluded.${excluded}`)}</Text>}
      {!excluded &&
        unanchored.map((item) => <UnanchoredNote key={item.id} ctx={ctx} item={item} />)}
      {!excluded && editable.length > 0 && (
        <details>
          <summary className="min-h-11 cursor-pointer font-bold text-accent">
            {ctx.t('sourceFix.date.open')}
          </summary>
          <div className="flex flex-col gap-2">
            <Label tone="sub">{ctx.t('sourceFix.date.compare')}</Label>
            {editable.map(({ item, live, trusted, dateLinks }) => (
              <DateEdit
                key={item.id}
                ctx={ctx}
                item={item}
                live={live}
                trusted={trusted}
                links={dateLinks ?? []}
              />
            ))}
          </div>
        </details>
      )}
      {!excluded && current.length > 0 && (
        <details>
          <summary className="min-h-11 cursor-pointer font-bold text-accent">
            {ctx.t('sourceFix.item.open')}
          </summary>
          <div className="flex flex-col gap-2">
            <Label tone="sub">{ctx.t('sourceFix.item.compare')}</Label>
            {deadlines.length > 0 && <Text quiet>{ctx.t('sourceFix.item.deadlineDate')}</Text>}
            {unconfirmed.length > 0 && <Text>{ctx.t('sourceFix.item.unconfirmed')}</Text>}
            {current
              .filter(({ trusted }) => trusted)
              .map(({ item }) => (
                <TimeEdit key={item.id} ctx={ctx} item={item} />
              ))}
          </div>
        </details>
      )}
      {!excluded && current.length > 0 && (
        <details>
          <summary className="min-h-11 cursor-pointer font-bold text-accent">
            {ctx.t('sourceFix.item.dismissOpen')}
          </summary>
          <div className="flex flex-col gap-2">
            {current.map(({ item }) => (
              <ItemDismiss key={item.id} ctx={ctx} item={item} />
            ))}
          </div>
        </details>
      )}
      {!excluded && (
        <details>
          <summary className="min-h-11 cursor-pointer font-bold text-accent">
            {ctx.t('sourceFix.discard.open')}
          </summary>
          <DiscardEdit ctx={ctx} source={source} />
        </details>
      )}
    </div>
  );
}
