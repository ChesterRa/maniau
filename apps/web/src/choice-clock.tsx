// 選べる手が、いつ消えるか（まにあうの芯：まだ選べるうちに）。今から要る時までを一本の時間にして、案ごとに
// 決め時までの残りを帯で見せる。段取りを受け持つ人が頭の中で数えている「どの手が、いつ取れなくなるか」を、
// 二人が同じ図で見られるようにする。決め時は目安（計算の前提が変われば動く）。過ぎた案は空の帯、決め時の
// 分からない案は帯を出さずにそう書く。図は飾りで、同じことを文でも書く（読み上げでも分かる）。携帯の
// 一画面目で案の札が見えるよう、一行の要約だけを出し、案ごとの帯は開いて見る。
import type { TFunction } from 'i18next';
import { daysBetween, formatDay, formatDayTime, minutesBetween } from './format';
import type { UiLanguage } from './i18n';

export interface ClockOption {
  key: string;
  /** 画面の言葉の案の名前。 */
  title: string;
  /** 決め時（無ければ分からない）。 */
  deadline?: string;
  expired: boolean;
}

/** 決め時までの残りの割合（今が 0、要る時が 1）。過ぎた・分からない物は無し。 */
export function remaining(
  now: string,
  until: string,
  deadline: string | undefined,
): number | undefined {
  if (deadline === undefined) return undefined;
  const span = Math.max(1, minutesBetween(now, until));
  return Math.min(1, Math.max(0, minutesBetween(now, deadline) / span));
}

export function ChoiceClock(props: {
  t: TFunction;
  lang: UiLanguage;
  tz: string;
  /** 今（計画の今）。 */
  now: string;
  /** 要る時（手配の始まり）。 */
  until: string;
  options: readonly ClockOption[];
}) {
  const { t, lang, tz, now, until } = props;
  // エンジンと同じ境目：決め時のちょうどその時は、まだ選べる（過ぎたのは決め時より後）。
  const open = (o: ClockOption) =>
    !o.expired && o.deadline !== undefined && minutesBetween(now, o.deadline) >= 0;
  const unknown = (o: ClockOption) => !o.expired && o.deadline === undefined;
  const rank = (o: ClockOption) => (open(o) ? 0 : o.expired ? 2 : 1);
  const rows = [...props.options].sort(
    (a, b) => rank(a) - rank(b) || (a.deadline ?? '9').localeCompare(b.deadline ?? '9'),
  );
  const left = rows.filter(open);
  const next = left[0];
  // 決め時の分からない手は、選べないとは言わない（分からないと言う）。
  const unsure = rows.filter(unknown).length;
  return (
    <section className="flex flex-col gap-1.5 rounded-[18px] border border-line bg-white px-4 py-3">
      <span className="text-sm font-bold text-sub">{t('clock.label')}</span>
      <span className="font-bold">
        {next?.deadline
          ? t('clock.summary', {
              count: left.length,
              option: next.title,
              when: formatDayTime(next.deadline, lang, tz),
            })
          : unsure > 0
            ? t('clock.unknownOnly', { count: unsure })
            : t('clock.none')}
      </span>
      <details className="group">
        <summary className="cursor-pointer text-sm text-accent-dark">{t('clock.show')}</summary>
        <div className="mt-2 flex flex-col gap-2.5">
          <ul className="flex flex-col gap-2">
            {rows.map((o) => {
              const ratio = o.expired ? undefined : remaining(now, until, o.deadline);
              const days = o.deadline === undefined ? undefined : daysBetween(now, o.deadline, tz);
              const soon = ratio !== undefined && days !== undefined && days <= 1;
              return (
                <li key={o.key} className="flex flex-col gap-1">
                  <span className="flex items-baseline justify-between gap-2 text-[15px]">
                    <span className={`min-w-0 truncate ${o.expired ? 'text-sub' : ''}`}>
                      {o.title}
                    </span>
                    <span
                      className={`shrink-0 tabular-nums ${soon ? 'font-bold text-warn' : 'text-sub'}`}
                    >
                      {o.expired
                        ? t('clock.gone')
                        : o.deadline === undefined
                          ? t('clock.unknown')
                          : t('clock.until', {
                              when: formatDayTime(o.deadline, lang, tz),
                              left: t('decide.daysLeft', { count: Math.max(0, days ?? 0) }),
                            })}
                    </span>
                  </span>
                  {ratio !== undefined && (
                    <span
                      aria-hidden="true"
                      className="h-2 w-full overflow-hidden rounded-full bg-line"
                    >
                      <span
                        className={`block h-full rounded-full ${soon ? 'bg-warn' : 'bg-accent'}`}
                        style={{ width: `${Math.round(ratio * 100)}%` }}
                      />
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <span aria-hidden="true" className="flex justify-between text-xs text-sub">
            <span>{t('clock.now')}</span>
            <span>{t('clock.need', { day: formatDay(until, lang, tz) })}</span>
          </span>
        </div>
      </details>
    </section>
  );
}
