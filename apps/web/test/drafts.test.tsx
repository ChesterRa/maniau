// 外に出す文（頼む・取り消す）と、決める画面の勧め。日付は相手の言葉で、取り消すのは頼んだ日で、
// 返事の期限は、頼む文と勧めで同じ物を使う。
import type { ExternalRequest } from '@maniau/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { askDraft, type Ctx, cancelDraft, DecideScreen } from '../src/screens';
import { ctxFor } from './ctx';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ');

/** 祖母への依頼（頼んだ日を、今の手配の日と別にできる）。 */
function grandmaRequest(window?: ExternalRequest['window']): ExternalRequest {
  const ctx = ctxFor('postponed', 'b', 'ja');
  const sent = ctx.plan.requests.find((r) => r.to === 'g');
  if (!sent) throw new Error('祖母への依頼が無い');
  const { window: _, ...rest } = sent;
  return window ? { ...rest, window } : rest;
}

describe('取り消しの文', () => {
  it('頼んだ時の日で書く（今の手配の日が替わっていても）', () => {
    const ctx = ctxFor('postponed', 'b', 'ja');
    const draft = cancelDraft(
      ctx,
      grandmaRequest({ start: '2026-12-07T08:10+09:00', end: '2026-12-07T18:15+09:00' }),
    );
    expect(draft).toContain('12月7日');
    const moved = cancelDraft(
      ctx,
      grandmaRequest({ start: '2026-12-14T08:10+09:00', end: '2026-12-14T18:15+09:00' }),
    );
    expect(moved).toContain('12月14日');
  });

  it('画面が英語でも、日本語で送る相手には、日付も日本語で書く', () => {
    const ctx = ctxFor('postponed', 'b', 'en');
    const draft = cancelDraft(
      ctx,
      grandmaRequest({ start: '2026-12-07T08:10+09:00', end: '2026-12-07T18:15+09:00' }),
    );
    expect(draft).toContain('12月7日');
    expect(draft).not.toMatch(/December|Monday/);
  });

  it('頼んだ日の控えが無ければ、今の手配の日で補わず、日付を書かない', () => {
    const ctx = ctxFor('postponed', 'b', 'ja');
    const draft = cancelDraft(ctx, grandmaRequest());
    expect(draft).not.toMatch(/\d+月\d+日/);
    expect(draft).toContain('前にお願いした件');
  });
});

describe('頼む文の条件（休みと言い切らない）', () => {
  // 見本の家族の 11/25：学習発表会が 12/5（土）にあれば、12/7（月）が振替休業日（まだ決まっていない）。
  const ITEM = 'n1:i6';
  const draftOf = (ctx: Ctx) => {
    const ask = ctx.plan.tasks.find((t) => t.external?.to === 'g');
    if (!ask) throw new Error('祖母に頼む作業が無い');
    return askDraft(ctx, ask);
  };
  /** 祖母に送る文の言葉を替える。 */
  const sendIn = (ctx: Ctx, lng: 'ja' | 'en'): Ctx => ({
    ...ctx,
    household: {
      ...ctx.household,
      members: ctx.household.members.map((m) =>
        m.id === 'g' ? { ...m, outboundLanguage: lng } : m,
      ),
    },
  });
  /** 事項の条件を替える（無ければ、一つの値で決まらない条件）。 */
  const withWhen = (ctx: Ctx, when?: { label: string; value: string }): Ctx => ({
    ...ctx,
    items: ctx.items.map((l) => {
      if (l.item.id !== ITEM) return l;
      const { when: _, ...rest } = l;
      return when ? { ...rest, when } : rest;
    }),
  });

  it('日本語で送る相手には、分かる条件を初めの文に書き、まだ決まっていないと添える', () => {
    const draft = draftOf(ctxFor('arrived', 'b', 'ja'));
    expect(draft).toContain(
      '学習発表会の実施日が12月5日（土）なら、12月7日（月）は陽菜の学校がお休みになります（まだ決まっていません）。',
    );
    expect(draft).toContain('お休みにならなかったら、このお願いはなしになります。');
    expect(draft).not.toContain('お休みです。');
  });

  it('画面が英語でも、日本語で送る相手には、同じ日本語の文を作る', () => {
    expect(draftOf(ctxFor('arrived', 'b', 'en'))).toBe(draftOf(ctxFor('arrived', 'b', 'ja')));
  });

  it('英語で送る相手に、お知らせの日本語の名前は入れず、条件しだいで決まっていないとだけ書く', () => {
    const draft = draftOf(sendIn(ctxFor('arrived', 'b', 'ja'), 'en'));
    expect(draft).toContain('may have no school on Monday, December 7');
    expect(draft).toContain("If there is school that day after all, we won't need your help.");
    expect(draft).not.toContain('学習発表会');
    expect(draft).not.toMatch(/has no school|12月/);
  });

  it('英語で送る相手に、英語の名前の条件なら、日付も英語で書く', () => {
    const ctx = withWhen(sendIn(ctxFor('arrived', 'b', 'en'), 'en'), {
      label: 'the presentation date',
      value: '2026-12-05',
    });
    expect(draftOf(ctx)).toContain(
      'will have no school on Monday, December 7 if the presentation date is Saturday, December 5 (not settled yet).',
    );
  });

  it('英語で送る相手に、半角カナ・補助面の漢字・日本語の値の条件も入れない', () => {
    const base = sendIn(ctxFor('arrived', 'b', 'ja'), 'en');
    for (const when of [
      { label: 'ｲﾍﾞﾝﾄ', value: 'yes' },
      { label: '𠮷日', value: 'yes' },
      { label: 'the weather', value: '雨' },
      { label: 'the event', value: 'ＯＫ' },
    ]) {
      const draft = draftOf(withWhen(base, when));
      expect(draft).toContain('may have no school on Monday, December 7 (not settled yet).');
      expect(draft).not.toContain(when.label);
    }
  });

  it('日本語で送る相手には、英語の名前の条件も、そのまま書く（訳さない）', () => {
    const ctx = withWhen(ctxFor('arrived', 'b', 'ja'), { label: 'Event', value: 'yes' });
    expect(draftOf(ctx)).toContain('Eventがあるなら、12月7日（月）は陽菜の学校がお休みになります');
  });

  it('一つの値で決まらない条件は、条件を書かず、休みになるかもしれないと書く', () => {
    const draft = draftOf(withWhen(ctxFor('arrived', 'b', 'ja')));
    expect(draft).toContain(
      '12月7日（月）は、陽菜の学校がお休みになるかもしれません（まだ決まっていません）。',
    );
    expect(draft).not.toContain('なら、');
    expect(draft).toContain('お休みにならなかったら、このお願いはなしになります。');
  });

  it('条件しだいでない日は、今までどおり休みと書き、なしになる文を添えない', () => {
    const ctx = ctxFor('arrived', 'b', 'ja');
    const settled: Ctx = {
      ...ctx,
      plan: {
        ...ctx.plan,
        arrangements: ctx.plan.arrangements.map((a) => {
          const { conditional: _, ...rest } = a;
          return rest;
        }),
      },
    };
    const draft = draftOf(settled);
    expect(draft).toContain('12月7日（月）は、陽菜の学校がお休みです。');
    expect(draft).not.toMatch(/まだ決まっていません|お休みにならなかったら/);
  });
});

describe('返事の期限', () => {
  const tipOf = (stage: string, at?: string) => {
    const ctx = ctxFor(stage, 'b', 'ja', at);
    const care = ctx.plan.arrangements.find((a) =>
      a.options.some((o) => o.key.includes('grandma')),
    );
    if (!care) throw new Error('子の居場所の手配が無い');
    return {
      ctx,
      html: text(renderToStaticMarkup(<DecideScreen ctx={ctx} arrangementKey={care.key} />)),
    };
  };

  it('前の晩がまだ先なら、勧めも頼む文も、同じ晩までに返事を頼む', () => {
    const { ctx, html } = tipOf('arrived');
    const ask = ctx.plan.tasks.find((t) => t.external?.to === 'g');
    if (!ask) throw new Error('祖母に頼む作業が無い');
    const draft = askDraft(ctx, ask);
    const night = draft.match(/(\d+月\d+日（.）)の夜までに/)?.[1];
    expect(night).toBeDefined();
    expect(html).toMatch(/の夜までに返事をもらえれば/);
    expect(html).toContain(String(night).replace(/（.）/, '').replace('月', '/').replace('日', ''));
  });

  it('前の晩が過ぎていれば、昨日までの返事を求めず、できるだけ早くと書く', () => {
    // 11/30 12:00。学童の決め時は当日 17:20 なので、前の晩（11/29）はもう過ぎている。
    const { ctx, html } = tipOf('chase', '2026-11-30T12:00+09:00');
    expect(
      ctx.plan.arrangements.flatMap((a) => a.options).find((o) => o.key.includes('gakudo')),
    ).toMatchObject({ expired: false, decisionDeadline: '2026-11-30T17:20+09:00' });
    expect(html).not.toMatch(/の夜までに返事をもらえれば/);
    expect(html).toContain('できるだけ早く返事をもらってください');
    const ask = ctx.plan.tasks.find((t) => t.external?.to === 'g');
    if (ask) expect(askDraft(ctx, ask)).not.toMatch(/の夜までに/);
  });
});
