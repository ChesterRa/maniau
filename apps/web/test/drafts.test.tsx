// 外に出す文（頼む・取り消す）と、決める画面の勧め。日付は相手の言葉で、取り消すのは頼んだ日で、
// 返事の期限は、頼む文と勧めで同じ物を使う。
import type { ExternalRequest } from '@maniau/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { askDraft, cancelDraft, DecideScreen } from '../src/screens';
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
