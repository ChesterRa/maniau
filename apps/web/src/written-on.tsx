// お知らせが書かれた日（「あした」「きょう」の基準。02-foundation §8）を選ぶ欄と、書かれた日が分からないまま
// 届いた（入れた）日から数えた読み取りの説明。お知らせを入れる札・確かめる札・日付を直す所で使う。
import {
  addDays,
  type Item,
  localDateOf,
  toEpochMinutes,
  WRITTEN_ON_MAX_DAYS_BEFORE,
  writtenOnProblem,
} from '@maniau/core';
import { formatDay, formatDayTime } from './format';
import type { Ctx } from './screens';
import { Text } from './ui';

/** 選んだ書かれた日を、そのまま送ってよいか（選んでいない時も良い）。今日は画面の時計（デモはデモの時計）。 */
export const writtenOnUsable = (ctx: Ctx, value: string | undefined) =>
  value === undefined || writtenOnProblem(value, ctx.now, ctx.tz) === undefined;

/**
 * お知らせが書かれた日を選ぶ欄（任意。初めは選ばない）。「きょう」「きのう」と日付で選び、同じ物をもう一度押すと
 * 選ばないに戻る。選ばなければ、「あした」は入れた日から数え、その日付を確かめてもらう（送り手が家族でも同じ）。
 */
export function WrittenOnField({
  ctx,
  value,
  disabled,
  onChange,
}: {
  ctx: Ctx;
  value: string | undefined;
  disabled: boolean;
  onChange: (value: string | undefined) => void;
}) {
  const today = localDateOf(toEpochMinutes(ctx.now), ctx.tz);
  const oldest = addDays(today, -WRITTEN_ON_MAX_DAYS_BEFORE);
  const choice = (day: string, label: string) => (
    <button
      type="button"
      aria-pressed={value === day}
      disabled={disabled}
      onClick={() => onChange(value === day ? undefined : day)}
      className={`min-h-11 rounded-xl border-[1.5px] px-3 font-bold ${value === day ? 'border-accent bg-accent text-white' : 'border-btn-line bg-white'}`}
    >
      {label}
    </button>
  );
  const day = (date: string) => formatDay(date, ctx.lang, ctx.tz);
  return (
    <fieldset className="flex flex-col gap-1 text-sm">
      <legend className="mb-1 text-sub">{ctx.t('input.writtenOn.label')}</legend>
      <div className="flex flex-wrap items-center gap-2">
        {choice(today, ctx.t('input.writtenOn.today'))}
        {choice(addDays(today, -1), ctx.t('input.writtenOn.yesterday'))}
        <input
          type="date"
          value={value ?? ''}
          min={oldest}
          max={today}
          disabled={disabled}
          aria-label={ctx.t('input.writtenOn.date')}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          className="min-h-11 min-w-0 rounded-lg border border-line bg-card px-2 text-base"
        />
      </div>
      {value === undefined ? (
        <span className="text-sub">
          {ctx.t(ctx.trialInput ? 'input.clockTrial' : 'input.clock', {
            now: formatDayTime(ctx.now, ctx.lang, ctx.tz),
          })}
        </span>
      ) : writtenOnUsable(ctx, value) ? (
        <span className="text-sub">{ctx.t('input.writtenOn.chosen', { day: day(value) })}</span>
      ) : (
        <span role="status">
          {ctx.t('input.writtenOn.problem', { oldest: day(oldest), today: day(today) })}
        </span>
      )}
    </fieldset>
  );
}

/**
 * 書かれた日が分からないまま、「あした」「きょう」を入れた日から数えた読み取りの説明（確かめる前の事項に出す）。
 * 書かれた日が違えば、日付を直してもらう。
 */
export function UnanchoredNote({ ctx, item }: { ctx: Ctx; item: Item }) {
  const from = item.interpretation.relativeDayFromReceived;
  if (from === undefined) return null;
  return (
    <Text>
      {ctx.t(
        item.interpretation.relativeDay === 'today'
          ? 'sources.unanchored.today'
          : 'sources.unanchored.tomorrow',
        { day: formatDay(from, ctx.lang, ctx.tz) },
      )}
    </Text>
  );
}
