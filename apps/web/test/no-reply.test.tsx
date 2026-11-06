// 返事待ちを追う札：頼んだ時間の始まりが近い（26 時間を切った）のに返事が記録されていなければ、頼んだ本人の
// 「今やること」に上げる。中身と押す物は、頼んだことの行と同じ。頼んだ時間が過ぎたら行に戻し、過ぎた事を書く。
// 架空のデモの家（祖母に頼んだ段。頼んだ時間は 12/7 8:10–18:15）。
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { type Ctx, TodayScreen } from '../src/screens';
import { ctxFor } from './ctx';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const shown = (ctx: Ctx) => text(renderToStaticMarkup(<TodayScreen ctx={ctx} />));
const RAISED = '2026-12-06T08:10+09:00';

describe('返事待ちを追う札', () => {
  it('26 時間を切ったら、頼んだ本人の今やることに出し、頼んだことの行には二度並べない（日英）', () => {
    const before = shown(ctxFor('asked', 'b', 'ja', '2026-12-06T06:09+09:00'));
    expect(before).not.toContain('おばあちゃんの返事を確かめる');
    expect(before).toContain('おばあちゃんの返事待ち');
    const ja = shown(ctxFor('asked', 'b', 'ja', RAISED));
    expect(ja).toContain('返事は未記録');
    expect(ja).toContain('おばあちゃんの返事を確かめる');
    expect(ja).toContain('11/25（水）に頼んだお願いの返事が、まだ記録されていません。');
    expect(ja).toContain('依頼の記録：陽菜の見守り・12/7（月） 8:10–18:15');
    expect(ja).toContain('「断られたら？」で次の手を見られます');
    expect(ja).not.toContain('おばあちゃんの返事待ち');
    expect(ja).not.toContain('いま決めることはありません');
    for (const label of [
      'OK だった',
      '断られた',
      '断られたら？',
      'まだ送っていなかった（押し間違い）',
    ])
      expect(ja).toContain(label);
    const en = shown(ctxFor('asked', 'b', 'en', RAISED));
    expect(en).toContain('Reply not recorded');
    expect(en).toContain('No reply has been recorded for the request you sent on');
    expect(en).toContain('Request record: care for 陽菜');
    // もう一人の大人には出さない（頼んだのは彩）。
    expect(shown(ctxFor('asked', 'a', 'ja', RAISED))).not.toContain('の返事を確かめる');
  });

  it('頼んだ時間が過ぎたら、頼んだことの行に戻し、過ぎた事と記録が無い事を書く（後から記録できる）', () => {
    const during = shown(ctxFor('asked', 'b', 'ja', '2026-12-07T18:14+09:00'));
    expect(during).toContain('おばあちゃんの返事を確かめる');
    expect(during).not.toContain('頼んだ時間は過ぎました');
    const ja = shown(ctxFor('asked', 'b', 'ja', '2026-12-07T18:15+09:00'));
    expect(ja).not.toContain('おばあちゃんの返事を確かめる');
    expect(ja).toContain('おばあちゃんの返事待ち');
    expect(ja).toContain('頼んだ時間は過ぎました。返事は記録されていません。');
    expect(ja).toContain('OK だった');
    const en = shown(ctxFor('asked', 'b', 'en', '2026-12-07T18:15+09:00'));
    expect(en).toContain('The requested time has passed. No reply has been recorded.');
    // 窓の前の返事待ちの行には書かない。
    expect(shown(ctxFor('asked', 'b', 'ja'))).not.toContain('頼んだ時間は過ぎました');
  });
});
