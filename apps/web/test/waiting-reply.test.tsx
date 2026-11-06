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

  it('子の居場所の返事待ちに、送った時の控えの子と窓を出す（日英）', () => {
    const ja = text(renderToStaticMarkup(<TodayScreen ctx={ctxFor('asked', 'b', 'ja')} />));
    expect(ja).toContain('依頼の記録：陽菜の見守り・12/7（月） 8:10–18:15');
    const en = text(renderToStaticMarkup(<TodayScreen ctx={ctxFor('asked', 'b', 'en')} />));
    expect(en).toContain('Request record: care for 陽菜');
    expect(en).toContain('Mon 12/7 8:10 AM–6:15 PM');
  });

  it('今の手配の日で控えを上書きせず、控えに無い時間や子を推さない', () => {
    const ctx = ctxFor('asked', 'b', 'ja');
    const card = ctx.today.quiet.find((item) => item.kind === 'waiting');
    if (card?.kind !== 'waiting') throw new Error('返事待ちが無い');
    const changed = {
      ...ctx,
      plan: {
        ...ctx.plan,
        arrangements: ctx.plan.arrangements.map((a) =>
          a.key === card.request.basis.arrangementKey
            ? { ...a, start: '2026-12-08T09:00+09:00', end: '2026-12-08T17:00+09:00' }
            : a,
        ),
      },
      today: { main: [], quiet: [card] },
    };
    const original = text(renderToStaticMarkup(<TodayScreen ctx={changed} />));
    expect(original).toContain('12/7（月） 8:10–18:15');
    expect(original).not.toContain('12/8（火） 9:00–17:00');
    const { window: _window, childId: _childId, ...old } = card.request;
    const missing = text(
      renderToStaticMarkup(
        <TodayScreen
          ctx={{ ...changed, today: { main: [], quiet: [{ ...card, request: old }] } }}
        />,
      ),
    );
    expect(missing).toContain('子どもの見守り（頼んだ時間は記録にありません）');
    expect(missing).not.toContain('陽菜の見守り');
    expect(missing).not.toContain('12/8（火） 9:00–17:00');
  });

  it('返事待ちが条件しだいなら条件を見せ、詳細が無ければ条件しだいと示す', () => {
    const ctx = ctxFor('asked', 'b', 'ja');
    const card = ctx.today.quiet.find((item) => item.kind === 'waiting');
    if (card?.kind !== 'waiting') throw new Error('返事待ちが無い');
    const conditional = { ...card, request: { ...card.request, conditional: true as const } };
    const known = text(
      renderToStaticMarkup(
        <TodayScreen ctx={{ ...ctx, today: { main: [], quiet: [conditional] } }} />,
      ),
    );
    expect(known).toContain('学習発表会の実施日が12/5（土）なら要ります');
    const noConditionDetail = {
      ...ctx,
      plan: {
        ...ctx.plan,
        requirements: [],
        arrangements: ctx.plan.arrangements.map((arrangement) => {
          const { conditional: _conditional, ...withoutCondition } = arrangement;
          return withoutCondition;
        }),
      },
      today: { main: [], quiet: [conditional] },
    };
    const unknown = text(renderToStaticMarkup(<TodayScreen ctx={noConditionDetail} />));
    expect(unknown).toContain('お知らせの条件しだいで要ります（まだ決まっていません）');
    const en = ctxFor('asked', 'b', 'en');
    const enCard = en.today.quiet.find((item) => item.kind === 'waiting');
    if (enCard?.kind !== 'waiting') throw new Error('返事待ちが無い');
    const enConditional = { ...enCard, request: { ...enCard.request, conditional: true as const } };
    const english = text(
      renderToStaticMarkup(
        <TodayScreen ctx={{ ...en, today: { main: [], quiet: [enConditional] } }} />,
      ),
    );
    expect(english).toContain('not settled yet');
    const { conditional: _conditional, ...certain } = conditional.request;
    const settled = text(
      renderToStaticMarkup(
        <TodayScreen
          ctx={{ ...ctx, today: { main: [], quiet: [{ ...card, request: certain }] } }}
        />,
      ),
    );
    expect(settled).not.toContain('なら要ります（まだ決まっていません）');
  });

  it('同じ相手への二つの依頼は、それぞれの控えの時間で区別できる', () => {
    const ctx = ctxFor('asked', 'b', 'ja');
    const first = ctx.today.quiet.find((item) => item.kind === 'waiting');
    if (first?.kind !== 'waiting') throw new Error('返事待ちが無い');
    const second = {
      ...first,
      request: {
        ...first.request,
        requestId: 'another-request',
        window: { start: '2026-12-08T09:00+09:00', end: '2026-12-08T17:00+09:00' },
      },
    };
    const shown = text(
      renderToStaticMarkup(
        <TodayScreen ctx={{ ...ctx, today: { main: [], quiet: [first, second] } }} />,
      ),
    );
    expect(shown).toContain('依頼の記録：陽菜の見守り・12/7（月） 8:10–18:15');
    expect(shown).toContain('依頼の記録：陽菜の見守り・12/8（火） 9:00–17:00');
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
