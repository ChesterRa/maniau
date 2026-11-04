// 家族の好み（いつもの店）の札（02-foundation §3.5）：買い物の札に「いつもの店」と書く。いつもの店に寄れる時が無い・
// 扱う店が「使わない」の店だけなら、ほかの店に黙って移さず、訳を書く。架空のデモの家。
import { DomainEvent, type Household } from '@maniau/core';
import { foldEvents } from '@maniau/core/engine';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { demoEvents } from '../../server/src/demo';
import { viewFor } from '../../server/src/views';
import i18n from '../src/i18n';
import { type Ctx, TodayScreen } from '../src/screens';
import { ctxFor, demoData } from './ctx';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const A = 'store-clothing-toyosu';
const B = 'store-kids-toyosu';
const AT = '2026-11-26T12:10+09:00';

/** 「聞いた」段の家を直して（家族の店の扱い・営業時間）、その大人の画面の材料にする。 */
function changed(change: (h: Household) => Household, memberId: string, lang: 'ja' | 'en'): Ctx {
  const events = [...demoEvents('asked')];
  const household = foldEvents(events).household;
  if (!household) throw new Error('家族の情報が無い');
  events.push(
    DomainEvent.parse({
      id: 'pref',
      householdId: events[0]?.householdId,
      seq: events.length + 1,
      version: 1,
      occurredAt: AT,
      recordedAt: AT,
      actorId: 'b',
      type: 'householdSet',
      household: change(structuredClone(household)),
    }),
  );
  const view = viewFor(events, memberId, AT);
  const me = view.household.members.find((m) => m.id === memberId);
  if (!me) throw new Error('大人が無い');
  return {
    plan: view.plan,
    household: view.household,
    today: view.today,
    items: view.items,
    sources: new Map(view.sources.map((s) => [s.id, s])),
    readings: demoData.readings,
    me,
    lang,
    tz: view.household.timeZone,
    now: view.now,
    t: i18n.getFixedT(lang),
    outbound: (lng) => i18n.getFixedT(lng),
    send: async () => ({ status: 'ok' }),
    go: () => {},
  };
}

/** A に、どの日も寄れなくする（家族が入れた営業時間で）。 */
const closedA = (h: Household): Household => ({
  ...h,
  places: h.places.map((p) =>
    p.id === A && p.hours ? { ...p, hours: { ...p.hours, periods: [] } } : p,
  ),
});

describe('いつもの店の札', () => {
  it('いつもの店に置いた買い物の札に「いつもの店」と書く（日英）', () => {
    const ja = text(renderToStaticMarkup(<TodayScreen ctx={ctxFor('asked', 'a', 'ja')} />));
    expect(ja).toContain('いつもの店です（「うち」の「周りの資源」で替えられます）');
    const en = text(renderToStaticMarkup(<TodayScreen ctx={ctxFor('asked', 'a', 'en')} />));
    expect(en).toContain('Your usual store (change it in “Around us” under “Family”)');
  });

  it('いつもの店に寄れる時が無ければ、ほかの店に移さず、いつもの店の名前と訳を書く（日英）', () => {
    const ja = text(renderToStaticMarkup(<TodayScreen ctx={changed(closedA, 'a', 'ja')} />));
    expect(ja).toContain('いつもの店で買う時がありません');
    expect(ja).toContain('いつもの店（豊洲駅の近くの衣料品店）に寄れる時が見つかりませんでした');
    expect(ja).not.toContain('いつもの店です（');
    const en = text(renderToStaticMarkup(<TodayScreen ctx={changed(closedA, 'a', 'en')} />));
    expect(en).toContain('No time at your usual store');
  });

  it('扱う店が「使わない」の店だけなら、その訳を書く', () => {
    const onlyNotUsed = (h: Household): Household => ({
      ...h,
      places: h.places.filter((p) => p.id !== B),
      resources: h.resources.map((r) => (r.placeId === A ? { ...r, use: 'notUsed' as const } : r)),
    });
    const ja = text(renderToStaticMarkup(<TodayScreen ctx={changed(onlyNotUsed, 'a', 'ja')} />));
    expect(ja).toContain('使わない店だけです');
    expect(ja).toContain('家族が「使わない」とした店（豊洲駅の近くの衣料品店）だけです');
  });
});
