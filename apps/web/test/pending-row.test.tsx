// もう一人の大人がまだ引き受けていない作業を、静かな札に一行で出す（だれが頼んだかは言わない）。頼まれた本人には
// 「おねがい」の札で出し、この行は出さない。架空のデモの家（「11/26 帰りの買い物」：健太への買い物の提案）。
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TodayScreen } from '../src/screens';
import { ctxFor } from './ctx';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('まだ引き受けていない作業の行', () => {
  it('彩の画面に、健太がまだ引き受けていない買い物を出す（日英）', () => {
    const ja = text(renderToStaticMarkup(<TodayScreen ctx={ctxFor('asked', 'b', 'ja')} />));
    expect(ja).toContain('健太さんが、まだ引き受けていません');
    expect(ja).toMatch(/まだ引き受けていません 白い長袖シャツを買う/);
    const en = text(renderToStaticMarkup(<TodayScreen ctx={ctxFor('asked', 'b', 'en')} />));
    expect(en).toContain('健太 hasn’t taken this on yet');
  });

  it('頼まれた本人（健太）には、この行を出さない（おねがいの札で出る）', () => {
    const ja = text(renderToStaticMarkup(<TodayScreen ctx={ctxFor('asked', 'a', 'ja')} />));
    expect(ja).not.toContain('まだ引き受けていません');
    expect(ja).toContain('おねがい');
  });
});
