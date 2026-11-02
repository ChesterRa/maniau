// どの店で買えるか分からない持ち物の札：間に合わないのではなく、買う時を決められないと書く（日英）。
import type { TodayCard } from '@maniau/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import i18n from '../src/i18n';
import { StuckCard } from '../src/screens';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const card: Extract<TodayCard, { kind: 'stuck' }> = {
  kind: 'stuck',
  arrangement: {
    key: 'arr:purchase:n7:h1',
    requirementKey: 'req:belongings:n7:h1',
    kind: 'purchase',
    atHomeUnknownId: 'u-atHome:n7:h1',
    start: '2026-11-25T20:30+09:00',
    end: '2026-12-05T08:00+09:00',
    status: 'undetermined',
    options: [],
    backupOptionKeys: [],
    reasons: [{ code: 'inputMissing', refs: ['storeKind'] }],
    live: true,
  },
  requirement: {
    key: 'req:belongings:n7:h1',
    kind: 'belongings',
    what: 'ハンカチ',
    by: '2026-12-05T08:00+09:00',
    nature: 'required',
    basis: { itemIds: ['n7:h1'] },
    live: true,
  },
};

const render = (lang: 'ja' | 'en') =>
  text(
    renderToStaticMarkup(
      <StuckCard
        ctx={
          {
            lang,
            tz: 'Asia/Tokyo',
            household: { members: [] },
            plan: { requirements: [card.requirement], arrangements: [card.arrangement] },
            items: [],
            t: i18n.getFixedT(lang),
            send: async () => ({ status: 'ok' }),
          } as never
        }
        card={card}
      />,
    ),
  );

it('どの店で買えるか分からないと書き、「用意できた」で閉じられる', () => {
  const ja = render('ja');
  expect(ja).toContain('買う所が分かりません');
  expect(ja).toContain('ハンカチ');
  expect(ja).toContain('12/5（土）までに要りますが、どの店で買えるか分からず');
  expect(ja).toContain('用意できた');
  expect(ja).not.toContain('このままでは間に合いません');
  const en = render('en');
  expect(en).toContain('No store found');
  expect(en).toContain('tell which store sells it');
});
