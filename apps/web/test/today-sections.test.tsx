// きょうを三つに分ける（今やること・頼んだこと・決まったこと）。押した後に、何を記録したかを一行で出す。送る文の
// 画面の押す字は結果を言い、起きない事は書かない。架空のデモの家の段から組む（押した時の動きは today-done で）。
import type { TodayCard } from '@maniau/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import i18n from '../src/i18n';
import { AskScreen, type Ctx, TodayScreen } from '../src/screens';
import { ctxFor } from './ctx';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const ja = i18n.getFixedT('ja');
/** きょうの一まとまりの見出し（札の題は除く）。 */
const SECTIONS = ['今やること', '頼んだこと', '決まったこと'];
const headings = (html: string) =>
  [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)]
    .map((m) => m[1] ?? '')
    .filter((h) => SECTIONS.includes(h));

describe('きょうの三つ', () => {
  it('返事待ちと、もう一人の引き受け待ちは「頼んだこと」。今やる事が無ければ、無いと出す', () => {
    const html = renderToStaticMarkup(<TodayScreen ctx={ctxFor('asked', 'b', 'ja')} />);
    expect(headings(html)).toContain('頼んだこと');
    expect(headings(html)).not.toContain('今やること');
    expect(text(html)).toContain('おばあちゃんの返事待ち');
    expect(text(html)).toContain(ja('today.nothing'));
    expect(text(html)).not.toContain('待っていること・やること');
  });

  it('札があれば「今やること」の下に出す', () => {
    const html = renderToStaticMarkup(<TodayScreen ctx={ctxFor('asked', 'a', 'ja')} />);
    expect(headings(html)[0]).toBe('今やること');
    expect(text(html)).not.toContain(ja('today.nothing'));
  });

  it('引き受けて済んでいない作業（まだ送っていない頼み事）は、今やることに出し、「無い」とは言わない', () => {
    const ctx = ctxFor('asked', 'a', 'ja');
    const proposal = ctx.today.main.find((c) => c.kind === 'proposal');
    if (proposal?.kind !== 'proposal') throw new Error('提案が無い');
    const task = { ...proposal.task, commitment: 'accepted' as const };
    const todo: TodayCard = { kind: 'todo', task };
    const html = renderToStaticMarkup(
      <TodayScreen
        ctx={{
          ...ctx,
          plan: { ...ctx.plan, tasks: ctx.plan.tasks.map((t) => (t.key === task.key ? task : t)) },
          today: { main: [], quiet: [todo] },
        }}
      />,
    );
    expect(headings(html)).toEqual(['今やること']);
    expect(text(html)).not.toContain(ja('today.nothing'));
  });

  it('日を決める事が残る「すること」だけでも、今やることに数え、「無い」とは言わない', () => {
    // 集まりの場面で、取り消しの札が片付いた後（札も作業も無いが、日の決まっていない「すること」が残る）。
    const ctx = ctxFor('club', 'a', 'ja');
    const html = renderToStaticMarkup(
      <TodayScreen ctx={{ ...ctx, today: { main: [], quiet: [] } }} />,
    );
    expect(text(html)).toContain(ja('when.list.label'));
    expect(headings(html)).toEqual(['今やること']);
    expect(text(html)).not.toContain(ja('today.nothing'));
  });

  it('相手が受け付けたと記録した頼み事は「決まったこと」。予備に押さえた物は予備と書く（日英）', () => {
    const html = renderToStaticMarkup(<TodayScreen ctx={ctxFor('backup', 'b', 'ja')} />);
    const ctx = ctxFor('backup', 'b', 'ja');
    const gakudo = ctx.plan.requests.find((r) => r.state === 'confirmed');
    if (!gakudo) throw new Error('受け付けた頼み事が無い');
    const place = ctx.household.places.find((p) => p.id === gakudo.to)?.name ?? '';
    expect(headings(html)).toEqual(['頼んだこと', '決まったこと']);
    expect(text(html)).toContain(`${place}が受け付けた`);
    expect(text(html)).toContain('予備として押さえています');
    // 頼んだ時間が過ぎた後は出さない。
    const later = renderToStaticMarkup(
      <TodayScreen ctx={ctxFor('backup', 'b', 'ja', '2026-12-07T18:30+09:00')} />,
    );
    expect(headings(later)).not.toContain('決まったこと');
    const en = text(renderToStaticMarkup(<TodayScreen ctx={ctxFor('backup', 'b', 'en')} />));
    expect(en).toContain('Settled');
    expect(en).toContain('Held as a backup');
  });

  it('根拠が消えた頼み事・確かめの要る頼み事は、決まったことに出さない', () => {
    expect(
      headings(renderToStaticMarkup(<TodayScreen ctx={ctxFor('postponed', 'b', 'ja')} />)),
    ).not.toContain('決まったこと');
    const ctx = ctxFor('backup', 'b', 'ja');
    const plan = {
      ...ctx.plan,
      requests: ctx.plan.requests.map((r) => ({ ...r, needsCheck: true })),
    };
    expect(headings(renderToStaticMarkup(<TodayScreen ctx={{ ...ctx, plan }} />))).not.toContain(
      '決まったこと',
    );
  });

  it('押した後の一行（送ったと記録した・返事を記録した）', () => {
    const ctx = ctxFor('asked', 'b', 'ja');
    expect(text(renderToStaticMarkup(<TodayScreen ctx={ctx} done="sent" />))).toContain(
      ja('today.done.sent'),
    );
    expect(text(renderToStaticMarkup(<TodayScreen ctx={ctx} />))).not.toContain(
      ja('today.done.sent'),
    );
  });
});

describe('送る文', () => {
  const askTask = (ctx: Ctx) => {
    const request = ctx.plan.requests[0];
    if (!request) throw new Error('頼み事が無い');
    return request.taskKey;
  };
  const shown = (ctx: Ctx, key: string) =>
    renderToStaticMarkup(<AskScreen ctx={ctx} taskKey={key} />);

  it('題は「送る文」、押す字は「LINE などで共有」「送ったことを記録」。文を直せるとは書かない', () => {
    const ctx = ctxFor('asked', 'b', 'ja');
    const html = shown(ctx, askTask(ctx));
    expect(html).toMatch(/<h1[^>]*>送る文<\/h1>/);
    expect(text(html)).not.toContain('文は直せます');
    expect(text(html)).toContain('LINE などで共有');
    expect(text(html)).toContain('送ったことを記録');
    expect(text(html)).toContain(ja('ask.next1'));
  });

  it('次に選べる手が無ければ、「予備の案をきょうに出す」とは書かない', () => {
    const ctx = ctxFor('asked', 'b', 'ja');
    const key = askTask(ctx);
    expect(text(shown(ctx, key))).toContain(ja('ask.next2'));
    const task = ctx.plan.tasks.find((t) => t.key === key);
    const only: Ctx = {
      ...ctx,
      plan: {
        ...ctx.plan,
        arrangements: ctx.plan.arrangements.map((a) =>
          a.key === task?.basis.arrangementKey
            ? { ...a, options: a.options.filter((o) => o.key === task.basis.optionKey) }
            : a,
        ),
      },
    };
    expect(text(shown(only, key))).toContain(ja('ask.next1'));
    expect(text(shown(only, key))).not.toContain(ja('ask.next2'));
  });
});
