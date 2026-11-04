// 返事待ちの行に、断られた時に移れる手を書く：確保できた予備があればそれを、無ければ、断られても間に合う返事の
// 期限（決める画面・頼む文と同じ。時計が進めば、次の手に替わる）。きょうの札と同じ判定で、食い違わない。架空のデモの家。
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TodayScreen } from '../src/screens';
import { ctxFor } from './ctx';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('返事待ちの行', () => {
  it('断られた時に移る手の決め時の前の晩までを、返事の期限として書き、時計が進めば次の手に替える', () => {
    const before = text(renderToStaticMarkup(<TodayScreen ctx={ctxFor('chase', 'b', 'ja')} />));
    expect(before).toContain('おばあちゃんの返事待ち');
    expect(before).toContain(
      '11/29（日）の夜までに返事をもらえれば、断られても「学童に預ける」に間に合います',
    );
    // 学童の決め時（11/30 17:20）が過ぎた後：次に移れるのは「健太さんが休む」。
    const after = text(
      renderToStaticMarkup(
        <TodayScreen ctx={ctxFor('chase', 'b', 'ja', '2026-11-30T21:00+09:00')} />,
      ),
    );
    expect(after).not.toContain('「学童に預ける」に間に合います');
    expect(after).toContain(
      '12/1（火）の夜までに返事をもらえれば、断られても「健太さんが休む」に間に合います',
    );
  });

  it('通用の「すること」の返事待ちには、間に合うとは書かない（使わない資源・済んでいない前提を別に確かめるので）', () => {
    const ctx = ctxFor('chase', 'b', 'ja');
    const plan = {
      ...ctx.plan,
      arrangements: ctx.plan.arrangements.map((a) =>
        a.key === 'arr:childCare:n1:i6:c' ? { ...a, kind: 'need' as const } : a,
      ),
    };
    // きょうの札は同じまま、返事待ちの依頼の手配だけを「すること」にする。
    const shown = text(
      renderToStaticMarkup(
        <TodayScreen ctx={{ ...ctx, plan, today: { main: [], quiet: ctx.today.quiet } }} />,
      ),
    );
    expect(shown).toContain('おばあちゃんの返事待ち');
    expect(shown).not.toContain('間に合います');
    expect(shown).not.toContain('予備の「');
  });

  it('予備が確保できていれば、それを書き、次の予備も、間に合う期限も出さない（日英）', () => {
    const ja = text(
      renderToStaticMarkup(
        <TodayScreen ctx={ctxFor('backup', 'b', 'ja', '2026-12-01T18:10+09:00')} />,
      ),
    );
    // 学童は、外の相手（学童）の受け付けを確かめた予備。当日の準備（弁当）は確保に含めないので、別にあると書く。
    expect(ja).toContain(
      '断られても、予備の「学童に預ける」に進めます（手順は済み、受け付けられています）。',
    );
    expect(ja).toContain('当日の準備は、予備に進む時に出します。');
    expect(ja).not.toContain('間に合います');
    expect(ja).not.toContain('予備に「健太さんが休む」も押さえますか？');
    const en = text(
      renderToStaticMarkup(
        <TodayScreen ctx={ctxFor('backup', 'b', 'en', '2026-12-01T18:10+09:00')} />,
      ),
    );
    expect(en).toContain(
      'If they say no, you can move to the backup “After-school care” (its steps are done and it was accepted).',
    );
    expect(en).toContain('Same-day preparations appear when the backup is used.');
  });
});
