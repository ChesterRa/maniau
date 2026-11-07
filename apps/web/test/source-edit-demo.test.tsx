// 元の文の画面の直し：見本の家族の読み取りで、日付の無い持ち物も名前を直せ、一件だけ外せること（11/7 見直しの
// 指摘：日付の欄の絞り込みで、持ち物が直す・外す一覧から落ちていた）。締切の日付はまだ直せないと書くこと。
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { SourcesScreen } from '../src/screens';
import { ctxFor } from './ctx';

const section = (html: string, summary: string) => {
  const start = html.indexOf(summary);
  if (start < 0) return undefined;
  const end = html.indexOf('</details>', start);
  return html.slice(start, end);
};

it('日付の無い持ち物（白い長袖シャツ）も、名前の直しと一件だけ外す一覧に出す。日付の直しには出さない', () => {
  const ctx = ctxFor('arrived', 'b', 'ja');
  const shirt = ctx.items.find((entry) => entry.item.kind === 'belongings');
  if (!shirt) throw new Error('持ち物が無い');
  expect(shirt.item.interpretation.date).toBeUndefined();
  const html = renderToStaticMarkup(<SourcesScreen ctx={ctx} sourceId={shirt.item.sourceId} />);
  expect(section(html, '時刻・名前を直す')).toContain(shirt.item.written);
  expect(section(html, '一件だけ計画から外す')).toContain(shirt.item.written);
  expect(section(html, '読み取った日付を直す') ?? '').not.toContain(shirt.item.written);
});

it('締切の欄から日を決める締切の事項は、日付の直しに出さず、まだ直せないと書く', () => {
  const base = ctxFor('arrived', 'b', 'ja');
  const [first] = base.items;
  if (!first) throw new Error('事項が無い');
  const due = {
    ...first,
    live: true,
    trusted: true,
    conditional: false,
    item: {
      ...first.item,
      id: `${first.item.sourceId}:due`,
      kind: 'deadline' as const,
      written: '申し込みは11月30日17時まで。',
      interpretation: { what: '申し込み', date: '2026-11-30', deadline: '2026-11-30T17:00+09:00' },
    },
  };
  const ctx = { ...base, items: [...base.items, due] };
  const html = renderToStaticMarkup(<SourcesScreen ctx={ctx} sourceId={first.item.sourceId} />);
  expect(section(html, '読み取った日付を直す') ?? '').not.toContain('申し込みは11月30日17時まで。');
  expect(section(html, '時刻・名前を直す')).toContain(
    '締切の日付と時刻は、ここではまだ直せません。',
  );
  expect(section(html, '一件だけ計画から外す')).toContain('申し込みは11月30日17時まで。');
});
