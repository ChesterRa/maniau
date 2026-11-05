// デモだけ：この時刻の知らせの候補を、デモの帯に出す（サーバーが家族の家庭の送り手と同じ決まりと検証器の門で
// 作った物。送らない）。候補も止めた物も無い時は何も出さない。帯を高くしないよう、閉じたまとめ（だれに何件か）
// にし、開くと大人ごとの文を出す。知らせの無い大人も「なし」と書く（だれに送らないかも見せる）。文は、
// ロック画面に出る文そのもの（二つ以上なら件数の文）。
import { type Household, type NotificationTitle, notificationMessage } from '@maniau/core';
import { useTranslation } from 'react-i18next';
import type { NotificationPreview } from './family';
import { formatDayTime } from './format';
import type { UiLanguage } from './i18n';

export function DemoNotifications(props: {
  preview: NotificationPreview | undefined;
  household: Household;
  lang: UiLanguage;
}) {
  const { t } = useTranslation();
  const { preview, household, lang } = props;
  if (!preview) return null;
  const count = (m: NotificationPreview['members'][number]) =>
    m.now.length + (m.morning?.titles.length ?? 0);
  const blocked = preview.members.reduce((sum, m) => sum + m.blocked, 0);
  if (!preview.blockedAll && blocked === 0 && preview.members.every((m) => count(m) === 0)) {
    return null;
  }
  const nameOf = (id: string) => household.members.find((m) => m.id === id)?.name ?? id;
  const text = (titles: NotificationTitle[]) =>
    notificationMessage(
      lang,
      titles.map((titleKey) => ({ titleKey })),
    ).body;
  const parts = [
    ...preview.members
      .filter((m) => count(m) > 0)
      .map((m) => t('demo.notify.item', { name: nameOf(m.memberId), count: count(m) })),
    ...(preview.blockedAll
      ? [t('demo.notify.itemBlockedAll')]
      : blocked > 0
        ? [t('demo.notify.itemBlocked', { count: blocked })]
        : []),
  ];
  return (
    <details className="leading-snug">
      <summary className="min-h-9 cursor-pointer font-bold text-warn">
        {t('demo.notify.summary', {
          list: new Intl.ListFormat(lang, { type: 'conjunction' }).format(parts),
        })}
      </summary>
      <div className="flex flex-col gap-0.5">
        <p className="text-sub">{t('demo.notify.note')}</p>
        {preview.blockedAll && <p className="text-warn">{t('demo.notify.blockedAll')}</p>}
        <ul className="flex flex-col gap-0.5">
          {preview.members.map((m) => {
            const name = nameOf(m.memberId);
            const empty = count(m) === 0 && m.blocked === 0;
            return (
              <li key={m.memberId} className="flex flex-col">
                {m.now.length > 0 && (
                  <span>{t('demo.notify.now', { name, text: text(m.now) })}</span>
                )}
                {m.morning && (
                  <span>
                    {t('demo.notify.morning', {
                      name,
                      time: formatDayTime(m.morning.at, lang, household.timeZone),
                      text: text(m.morning.titles),
                    })}
                  </span>
                )}
                {m.blocked > 0 && (
                  <span className="text-warn">
                    {t('demo.notify.blocked', { name, count: m.blocked })}
                  </span>
                )}
                {empty && <span className="text-sub">{t('demo.notify.none', { name })}</span>}
              </li>
            );
          })}
        </ul>
      </div>
    </details>
  );
}
