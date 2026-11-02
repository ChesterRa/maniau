// 条件しだいの事項：一つの未定の値で決まる時は、どの値の時かを書く（同じ日の二つの事項を、元の文を
// 読み直さずに見分けられるように）。一つの値で決まらない時は「条件しだい」とだけ書く。
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Heard } from '../src/family';
import { type Ctx, SayReply, WeekScreen } from '../src/screens';
import { ctxFor } from './ctx';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const question: Heard = {
  kind: 'question',
  refs: { taskKeys: [], requestIds: [], itemIds: ['n1:i6', 'n1:i7'] },
};
const answer = (ctx: Ctx) =>
  text(
    renderToStaticMarkup(
      <SayReply ctx={ctx} reply={question} busy={false} onRecord={() => {}} onClear={() => {}} />,
    ),
  );

describe('条件しだいの事項', () => {
  it('問いの答えで、同じ日の二つの事項を、どの値の時かで見分ける', () => {
    const shown = answer(ctxFor('chase', 'b', 'ja'));
    expect(shown).toContain('振替休業日・12/7（月） 学習発表会の実施日が12/5（土）なら');
    expect(shown).toContain('通常授業・12/7（月） 学習発表会の実施日が12/8（火）なら');
    expect(answer(ctxFor('chase', 'b', 'en'))).toContain('if 学習発表会の実施日 is Tue 12/8');
  });

  it('よていの週でも、どの値の時かを書く。一つの値で決まらない時は「条件しだい」のまま', () => {
    const ctx = ctxFor('backup', 'b', 'ja');
    const shown = text(renderToStaticMarkup(<WeekScreen ctx={ctx} />));
    expect(shown).toContain('振替休業日（学習発表会の実施日が12/5（土）なら）');
    expect(shown).toContain('通常授業（学習発表会の実施日が12/8（火）なら）');
    const complex: Ctx = {
      ...ctx,
      items: ctx.items.map(({ when, ...l }) => (l.item.id === 'n1:i6' ? l : { ...l, when })),
    };
    expect(text(renderToStaticMarkup(<WeekScreen ctx={complex} />))).toContain(
      '振替休業日（条件しだい）',
    );
  });
  it('日付に見えても実在しない値は、別の日に直さず、そのまま書く（画面を落とさない）', () => {
    const ctx = ctxFor('backup', 'b', 'ja');
    const withValue = (value: string): Ctx => ({
      ...ctx,
      items: ctx.items.map((l) =>
        l.item.id === 'n1:i6' && l.when ? { ...l, when: { ...l.when, value } } : l,
      ),
    });
    const overflow = text(renderToStaticMarkup(<WeekScreen ctx={withValue('2026-02-30')} />));
    expect(overflow).toContain('振替休業日（学習発表会の実施日が2026-02-30なら）');
    expect(overflow).not.toContain('3/2');
    const broken = text(renderToStaticMarkup(<WeekScreen ctx={withValue('2026-13-40')} />));
    expect(broken).toContain('学習発表会の実施日が2026-13-40なら');
    expect(answer(withValue('2026-13-40'))).toContain('学習発表会の実施日が2026-13-40なら');
  });

  it('確かめていない上に条件しだいの事項は、両方を書く', () => {
    const ctx = ctxFor('backup', 'b', 'ja');
    const unconfirmed: Ctx = {
      ...ctx,
      items: ctx.items.map((l) => (l.item.id === 'n1:i6' ? { ...l, trusted: false } : l)),
    };
    expect(text(renderToStaticMarkup(<WeekScreen ctx={unconfirmed} />))).toContain(
      '振替休業日（未確認・学習発表会の実施日が12/5（土）なら）',
    );
  });
});
