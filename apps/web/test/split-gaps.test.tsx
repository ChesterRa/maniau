// 子の居場所で、見守れる大人を確かめられない時間が分かれる日（エンジンの splitGaps）：きょうの決める札と決める画面に、
// 全部の時間と、この手配がどの時間の分かを書き、お勧めを出さない訳を書く。
import type { Arrangement, TodayCard } from '@maniau/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEMO_STAGES, demoEvents } from '../../server/src/demo';
import { previewChange } from '../../server/src/preview';
import { householdPreviewLines } from '../src/household';
import { AskScreen, type Ctx, DecideScreen, TodayScreen } from '../src/screens';
import { WhatIfOutcome } from '../src/what-if';
import { ctxFor } from './ctx';

const care = 'arr:childCare:n1:i6:c';
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
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const SPLIT = {
  code: 'splitGaps' as const,
  refs: [
    '2026-12-07T10:00+09:00/2026-12-07T12:00+09:00',
    '2026-12-07T14:00+09:00/2026-12-07T17:00+09:00',
  ],
};
/** 手配を、12/7 に 10–12 時と 14–17 時に分かれた日の物にする（エンジンが出す形）。 */
const withSplit = (a: Arrangement): Arrangement => ({
  ...a,
  start: '2026-12-07T14:00+09:00',
  end: '2026-12-07T17:00+09:00',
  reasons: [...a.reasons, SPLIT],
});

/** 届いた夜の段の手配を、12/7 に 10–12 時と 14–17 時に分かれた日として見せる（エンジンが出す形）。 */
function splitCtx(lang: 'ja' | 'en'): Ctx {
  const ctx = ctxFor('arrived', 'b', lang);
  const base = ctx.plan.arrangements.find((a) => a.key === care);
  if (!base) throw new Error('手配が無い');
  const { recommendedOptionKey: _r, recommendedReason: _why, ...rest } = base;
  const arrangement: Arrangement = {
    ...rest,
    start: '2026-12-07T14:00+09:00',
    end: '2026-12-07T17:00+09:00',
    reasons: [
      {
        code: 'splitGaps',
        refs: [
          '2026-12-07T10:00+09:00/2026-12-07T12:00+09:00',
          '2026-12-07T14:00+09:00/2026-12-07T17:00+09:00',
        ],
      },
    ],
  };
  const card: TodayCard = { kind: 'decide', arrangement };
  return {
    ...ctx,
    plan: {
      ...ctx.plan,
      arrangements: ctx.plan.arrangements.map((a) => (a.key === care ? arrangement : a)),
    },
    today: { main: [card], quiet: [] },
  };
}

describe('見守れる大人を確かめられない時間が分かれる日', () => {
  it('きょうの札と決める画面に、全部の時間と、この手配の分を書く', () => {
    const ctx = splitCtx('ja');
    const today = text(renderToStaticMarkup(<TodayScreen ctx={ctx} />));
    expect(today).toContain(
      '見守れる大人を確かめられない時間が分かれています（10:00–12:00、14:00–17:00）',
    );
    expect(today).toContain('この手配は 14:00–17:00 の分だけです');
    const decide = text(renderToStaticMarkup(<DecideScreen ctx={ctx} arrangementKey={care} />));
    expect(decide).toContain('見守れる大人を確かめられない時間は 10:00–12:00、14:00–17:00 です');
    expect(decide).toContain('頼む文も、この時間の分です');
    expect(decide).toContain(ctx.t('decide.noRecommendation.split'));
    expect(decide).not.toContain('おすすめ');
  });

  it('間に合う手が無い札にも、全部の時間と、この手配の分を書く', () => {
    const base = splitCtx('ja');
    const arrangement = base.plan.arrangements.find((a) => a.key === care);
    if (!arrangement) throw new Error('手配が無い');
    const card: TodayCard = { kind: 'stuck', arrangement };
    const ctx = { ...base, today: { main: [card], quiet: [] } };
    const shown = text(renderToStaticMarkup(<TodayScreen ctx={ctx} />));
    expect(shown).toContain('このままでは間に合いません');
    expect(shown).toContain('（10:00–12:00、14:00–17:00）');
  });

  it('英語でも同じ物を出す', () => {
    const ctx = splitCtx('en');
    const today = text(renderToStaticMarkup(<TodayScreen ctx={ctx} />));
    expect(today).toContain('the times we can’t confirm an adult to watch are split');
    const decide = text(renderToStaticMarkup(<DecideScreen ctx={ctx} arrangementKey={care} />));
    expect(decide).toContain('This arrangement is for');
    expect(decide).not.toContain('only covers');
    expect(decide).toContain(ctx.t('decide.noRecommendation.split'));
  });

  describe('保存の前の「変わること」（手配の時間が同じなら → の行を出さない）', () => {
    const AFTERNOON = { start: '2026-12-07T14:00+09:00', end: '2026-12-07T17:00+09:00' };
    const BOTH = [{ start: '2026-12-07T10:00+09:00', end: '2026-12-07T12:00+09:00' }, AFTERNOON];
    const linesOf = (
      lang: 'ja' | 'en',
      extra: { split?: typeof BOTH; splitBefore?: typeof BOTH },
    ) => {
      const ctx = ctxFor('arrived', 'b', lang);
      const windows = [
        {
          arrangementKey: care,
          kind: 'childCare' as const,
          childId: 'c',
          before: AFTERNOON,
          after: AFTERNOON,
          ...extra,
        },
      ];
      return householdPreviewLines(ctx, {
        changes: { ...NONE, windows },
        issues: [],
        unverified: [],
        seen: 'x',
        throughSeq: ctx.plan.throughSeq,
      });
    };

    it('一つが二つに分かれる：全部の時間と手配の分', () => {
      const lines = linesOf('ja', { split: BOTH });
      expect(lines.some((l) => l.includes('→'))).toBe(false);
      const line = lines.find((l) => l.includes('見守れる大人を確かめられない時間が分かれます'));
      expect(line).toContain('10:00–12:00');
      expect(line).toContain('手配は');
      expect(line).toContain('の分だけです');
      expect(linesOf('en', { split: BOTH }).join(' ')).toContain('is for');
    });

    it('二つが一つになる：変わらないとは言わず、前の時間も書く', () => {
      const lines = linesOf('ja', { splitBefore: BOTH });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('だけになります');
      expect(lines[0]).toContain('前は');
      expect(lines[0]).toContain('10:00–12:00');
      expect(linesOf('en', { splitBefore: BOTH })[0]).toContain('before:');
    });

    it('分かれ方が変わる（二つのまま）：今の全部の時間を書く', () => {
      const lines = linesOf('ja', { split: BOTH, splitBefore: [AFTERNOON, AFTERNOON] });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('分かれます');
    });
  });

  it('「断られたら？」の仮の計算と、頼む文の画面にも、全部の時間と手配の分を書く', () => {
    const ctx = ctxFor('asked', 'b', 'ja');
    const request = ctx.plan.requests.find((r) => r.requestId === 'r-grandma');
    const current = ctx.plan.arrangements.find((a) => a.key === request?.basis.arrangementKey);
    if (!request || !current) throw new Error('依頼か手配が無い');
    const now = DEMO_STAGES.find((s) => s.id === 'asked')?.now ?? '';
    const shown = previewChange(
      demoEvents('asked'),
      { memberId: 'b', now },
      { type: 'recordReply', requestId: 'r-grandma', reply: 'no' },
    );
    if ('reason' in shown || !shown.arrangement) throw new Error('計算できない');
    const whatIf = text(
      renderToStaticMarkup(
        <WhatIfOutcome
          ctx={ctx}
          current={current}
          preview={{ ...shown, arrangement: withSplit(shown.arrangement) }}
          taskKey={request.taskKey}
        />,
      ),
    );
    expect(whatIf).toContain(
      '見守れる大人を確かめられない時間が分かれています（10:00–12:00、14:00–17:00）',
    );
    const split: Ctx = {
      ...ctx,
      plan: {
        ...ctx.plan,
        arrangements: ctx.plan.arrangements.map((a) => (a.key === current.key ? withSplit(a) : a)),
      },
    };
    const ask = text(renderToStaticMarkup(<AskScreen ctx={split} taskKey={request.taskKey} />));
    expect(ask).toContain('この手配は 14:00–17:00 の分だけです');
  });
});
