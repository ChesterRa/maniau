// 変わったこと：延期のお知らせの後、二人に同じまとめを見せる。自分の分は「あなた」、相手の分は名前で、
// 済んだかと一緒に。延期の前の段には出さない。
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TodayScreen } from '../src/screens';
import { ctxFor } from './ctx';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('変わったこと', () => {
  it('延期の後：要らなくなった預け先、二人それぞれの取り消し、期限の変わったシャツ', () => {
    const aya = text(renderToStaticMarkup(<TodayScreen ctx={ctxFor('postponed', 'b', 'ja')} />));
    expect(aya).toContain('変わったこと');
    expect(aya).toContain('学習発表会の延期について');
    expect(aya).toMatch(/12\/7.*の振替休業日の預け先は、要らなくなりました/);
    expect(aya).toMatch(/に取り消しを伝える：あなた\s*まだ/);
    expect(aya).toMatch(/に取り消しを伝える：健太\s*まだ/);
    // 日だけの締切に、書かれていない時刻（仕組みが置く朝の 8:00）を付けない。
    expect(aya).toContain('白い長袖シャツ：12/5（土） → 12/8（火）まで');
    expect(aya).toContain('（用意はできています）');
    const kenta = text(renderToStaticMarkup(<TodayScreen ctx={ctxFor('postponed', 'a', 'en')} />));
    expect(kenta).toContain('What changed');
    expect(kenta).toMatch(/cancelled: you\s*Not yet/);
    expect(kenta).toMatch(/cancelled: 彩\s*Not yet/);
  });

  it('延期の前の段では出さない', () => {
    for (const stage of ['arrived', 'asked', 'chase', 'backup']) {
      const shown = text(renderToStaticMarkup(<TodayScreen ctx={ctxFor(stage, 'b', 'ja')} />));
      expect(shown, stage).not.toContain('変わったこと');
    }
  });
});
