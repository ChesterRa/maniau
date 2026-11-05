// 手が離せない時間の見せ方：いつにするかの候補と重なれば、勧め・候補・決めた日の近くに一行出し（答えは変えない）、
// 決めた日が後から重なった時は「きょう」にも入口を出す。保存の前の「この変更で変わること」と、その日の画面・「うち」
// の一覧にも出す。足す操作は unavailable-click.test.tsx。
import type { HouseholdPreview, NeedWhen, PlanResult } from '@maniau/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HouseholdScreen, householdPreviewLines } from '../src/household';
import { MemberDayScreen } from '../src/member-day';
import type { Ctx } from '../src/screens';
import { WhenList, WhenScreen } from '../src/when';
import { ctxFor } from './ctx';

const CLUB = 'req:need:f-demo-club:i1';
const KENTA = { id: 'u-kenta', memberId: 'a', date: '2026-12-19', start: '09:30', end: '10:30' };
const BUSY = {
  personId: 'a',
  unavailableId: 'u-kenta',
  start: '2026-12-19T09:30+09:00',
  end: '2026-12-19T10:30+09:00',
};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const NONE = {
  added: [],
  removed: [],
  moved: [],
  unplaced: [],
  placed: [],
  reassigned: [],
  changed: [],
  relocated: [],
  reconfirm: [],
  released: [],
  cancels: [],
  checks: [],
  deadlines: [],
  windows: [],
  conflicts: [],
  rechoose: [],
};

/** club の段に、健太の 12/19 09:30–10:30 の手が離せない時間を置く（候補 c2 と重なる。エンジンが出す形）。 */
function busyCtx(lang: 'ja' | 'en', chosen = false): Ctx {
  const ctx = ctxFor('club', 'a', lang);
  const mark = (when: NeedWhen): NeedWhen => {
    const c2 = when.candidates.find((c) => c.id === 'c2');
    if (!c2) throw new Error('候補 c2 が無い');
    return {
      ...when,
      candidates: when.candidates.map((c) => (c.id === 'c2' ? { ...c, unavailable: [BUSY] } : c)),
      ...(chosen ? { chosen: { candidateId: 'c2', rev: c2.rev, stale: false, changes: [] } } : {}),
    };
  };
  const plan: PlanResult = {
    ...ctx.plan,
    requirements: ctx.plan.requirements.map((r) =>
      r.key === CLUB && r.when ? { ...r, when: mark(r.when) } : r,
    ),
  };
  return { ...ctx, plan, household: { ...ctx.household, unavailable: [KENTA] } };
}

describe('いつにするかの候補と重なる', () => {
  it('重なる候補にだけ一行を出す（答えの数は同じ）', () => {
    const shown = text(
      renderToStaticMarkup(<WhenScreen ctx={busyCtx('ja')} requirementKey={CLUB} />),
    );
    const plain = text(
      renderToStaticMarkup(<WhenScreen ctx={ctxFor('club', 'a', 'ja')} requirementKey={CLUB} />),
    );
    expect(shown).toContain(
      '今の記録では、健太（9:30–10:30）の手が離せない時間と重なります。確かめてください。',
    );
    expect(shown.split('の手が離せない時間と重なります').length - 1).toBe(1);
    expect(plain).not.toContain('手が離せない');
    // その一行のほかは、同じ画面（この例では、答え・数え・勧めも同じ）。
    expect(
      shown
        .replace(
          /今の記録では、健太（9:30–10:30）の手が離せない時間と重なります。確かめてください。/,
          ' ',
        )
        .replace(/\s+/g, ' '),
    ).toBe(plain);
  });

  it('決めた日が重なる時は、決めた日の札と「きょう」の入口に出す（英語も）', () => {
    const ctx = busyCtx('ja', true);
    const screen = text(renderToStaticMarkup(<WhenScreen ctx={ctx} requirementKey={CLUB} />));
    expect(screen).toContain('決めた日');
    expect(screen.indexOf('の手が離せない時間と重なります')).toBeGreaterThan(
      screen.indexOf('決めた日'),
    );
    expect(text(renderToStaticMarkup(<WhenList ctx={ctx} />))).toContain(
      '決めた日が、記録した手が離せない時間と重なります',
    );
    // 重ならない決めた日は、きょうの入口に出さない（今までどおり）。
    const clear = busyCtx('ja', true);
    const unmarked: Ctx = {
      ...clear,
      plan: {
        ...clear.plan,
        requirements: clear.plan.requirements.map((r) =>
          r.key === CLUB && r.when
            ? {
                ...r,
                when: {
                  ...r.when,
                  candidates: r.when.candidates.map(({ unavailable: _u, ...c }) => c),
                },
              }
            : r,
        ),
      },
    };
    const list = text(renderToStaticMarkup(<WhenList ctx={unmarked} />));
    expect(list).toContain('陽菜を見てもらう');
    expect(list).not.toContain('クラブの練習');
    const en = busyCtx('en', true);
    expect(text(renderToStaticMarkup(<WhenList ctx={en} />))).toContain(
      'the chosen day overlaps a recorded busy time',
    );
    expect(text(renderToStaticMarkup(<WhenScreen ctx={en} requirementKey={CLUB} />))).toContain(
      'By the current record, this overlaps busy time for 健太 (9:30 AM–10:30 AM). Please check.',
    );
  });

  it('保存の前の「この変更で変わること」に、新しくできる重なりと、無くなる重なりを書く', () => {
    const overlap = {
      requirementKey: CLUB,
      what: 'クラブの練習',
      candidateId: 'c2',
      candidate: { start: '2026-12-19T09:00+09:00', end: '2026-12-19T12:00+09:00' },
      personId: 'a',
      unavailableId: 'u-kenta',
      busy: { start: BUSY.start, end: BUSY.end },
    };
    const lines = (lang: 'ja' | 'en', change: 'added' | 'removed') => {
      const ctx = ctxFor('club', 'a', lang);
      const preview: HouseholdPreview = {
        changes: { ...NONE, overlaps: [{ ...overlap, change }] },
        issues: [],
        unverified: [],
        seen: 'x',
        throughSeq: ctx.plan.throughSeq,
      };
      return householdPreviewLines(ctx, preview);
    };
    expect(lines('ja', 'added')).toEqual([
      '「クラブの練習」の候補 12/19（土） 9:00–12:00：この変更を記録すると、健太の手が離せない時間（9:30–10:30）と重なります。答えは変えません。',
    ]);
    expect(lines('ja', 'removed')).toEqual([
      '「クラブの練習」の候補 12/19（土） 9:00–12:00：健太の手が離せない時間（9:30–10:30）と重ならなくなります。',
    ]);
    expect(lines('en', 'added')).toEqual([
      'Candidate Sat 12/19 9:00 AM–12:00 PM for “クラブの練習”: if you record this change, it overlaps 健太’s busy time (9:30 AM–10:30 AM). Answers stay as they are.',
    ]);
  });
});

describe('その日の画面と「うち」', () => {
  it('記録した時間を並べ、一つずつ外せる。「うち」の一覧にも出す', () => {
    const ctx = busyCtx('ja');
    const shown = text(
      renderToStaticMarkup(
        <MemberDayScreen
          ctx={ctx}
          route={{ name: 'memberDay', memberId: 'a', date: '2026-12-19' }}
        />,
      ),
    );
    expect(shown).toContain('手が離せない時間');
    expect(shown).toContain('09:30–10:30 外して見る');
    expect(shown).toContain('この時間を足して見る');
    expect(text(renderToStaticMarkup(<HouseholdScreen ctx={ctx} />))).toContain(
      '健太：手が離せない 09:30–10:30',
    );
    // 記録の無い日は「ありません」と書く（足す欄は出す）。
    const other = text(
      renderToStaticMarkup(
        <MemberDayScreen
          ctx={ctx}
          route={{ name: 'memberDay', memberId: 'a', date: '2026-12-20' }}
        />,
      ),
    );
    expect(other).toContain('この日に記録してある手が離せない時間はありません。');
    expect(other).not.toContain('外して見る');
  });
});
