// 通用の「すること」の画面（選べる手）：約束が全部そろっても受け持てると示せない時間（coverGaps）が残る手に、その時間を
// 一行で添え、どの手にも残る時だけ、勧めない訳をまとめて書く。断られたらの仮の計算では、通用の「すること」に
// 「間に合います」を書かず、頼む文にも、ほかの手から出した返事の期限を書かない（子の居場所だけ）。画面の材料は、
// サーバーと同じ命令と計算で作る（デモの家・架空の家族。家の情報に足すやり方は試験の材料だけ）。
import { type Command, type PreviewCommand, proposalSnapshot, type Way } from '@maniau/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../../server/src/commands';
import { demoEvents } from '../../server/src/demo';
import { previewChange } from '../../server/src/preview';
import { memoryStore } from '../../server/src/store';
import { viewFor } from '../../server/src/views';
import i18n from '../src/i18n';
import { NeedScreen } from '../src/need';
import { askDraft, type Ctx } from '../src/screens';
import { WhatIfOutcome } from '../src/what-if';
import { ctxFor } from './ctx';

const NOW = '2026-11-25T20:00+09:00';
// 土曜の午後（二人とも家にいる）。
const NEED = {
  text: '土曜の 13 時から 15 時に点検があるので、だれか立ち会ってほしい。',
  interpretation: {
    what: '点検の立ち会い',
    shape: 'window' as const,
    date: '2026-11-28',
    startTime: '13:00',
    endTime: '15:00',
  },
};
const cost = { leaveMinutes: 0, helperRequests: 0, yen: 0, extraTasks: 0 };
const tidy: Way = {
  id: 'way-tidy',
  name: '点検の前に場所を片付ける',
  steps: [
    {
      id: 'tidy',
      name: '片付ける',
      durationMin: 30,
      segments: ['home'],
      waitAfterMin: 0,
      assigneeId: 'a',
    },
  ],
  cost,
};
const homeA: Way = {
  id: 'way-home-a',
  name: '健太が家で立ち会う',
  steps: [
    {
      id: 'stay',
      name: '家で立ち会う',
      durationMin: 0,
      segments: ['home'],
      waitAfterMin: 0,
      assigneeId: 'a',
      cover: true,
    },
  ],
  cost,
};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ');

function family(extraWays: Way[]) {
  const events0 = demoEvents('arrived').map((e) =>
    e.type === 'householdSet'
      ? { ...e, household: { ...e.household, ways: [...e.household.ways, ...extraWays] } }
      : e,
  );
  const store = memoryStore(new Map([['demo', events0]]));
  const events = () => store.withHousehold('demo', (log) => [...log.events()]);
  let n = 0;
  const run = (command: Command, memberId = 'b') =>
    runCommand(
      store,
      'demo',
      { memberId, now: NOW, operationId: `gap-${++n}`, demo: true },
      command,
    );
  const write = async (command: PreviewCommand) => {
    const shown = previewChange(await events(), { memberId: 'b', now: NOW }, command);
    if ('reason' in shown) throw new Error(shown.reason);
    expect(
      await run({ ...command, seen: { throughSeq: shown.throughSeq, changes: shown.seen } }),
    ).toMatchObject({ status: 'ok' });
  };
  const ctx = async (lang: 'ja' | 'en' = 'ja'): Promise<Ctx> => {
    const view = viewFor(await events(), 'b', NOW);
    const me = view.household.members.find((m) => m.id === 'b');
    if (!me) throw new Error('大人が無い');
    return {
      plan: view.plan,
      household: view.household,
      today: view.today,
      items: view.items,
      sources: new Map(view.sources.map((s) => [s.id, s])),
      readings: [],
      me,
      lang,
      tz: view.household.timeZone,
      now: NOW,
      t: i18n.getFixedT(lang),
      outbound: (lng) => i18n.getFixedT(lng),
      send: async () => ({ status: 'ok' }),
      previewChange: async () => undefined,
      go: () => {},
    };
  };
  const stated = async (wayIds: string[]) => {
    await write({ type: 'stateNeed', ...NEED });
    const view = viewFor(await events(), 'b', NOW);
    const itemId = view.plan.requirements.find((r) => r.kind === 'need' && r.live)?.basis
      .itemIds[0];
    if (!itemId) throw new Error('「すること」が無い');
    await write({ type: 'setNeedWays', itemId, wayIds });
    const arrangement = viewFor(await events(), 'b', NOW).plan.arrangements.find(
      (a) => a.kind === 'need' && a.live,
    );
    if (!arrangement) throw new Error('手配が無い');
    return arrangement;
  };
  return { ctx, stated, run, events };
}

describe('受け持てると示せない時間が残る手', () => {
  it('「すること」の画面で、その時間を手に添え、残りの無い手を勧める（日英）', async () => {
    const app = family([tidy, homeA]);
    const arrangement = await app.stated(['way-tidy', 'way-home-a']);
    const tidyOption = arrangement.options.find((o) => o.templateId === 'way-tidy');
    expect(tidyOption?.coverGaps).toBeDefined();
    expect(arrangement.recommendedOptionKey).toBe(
      arrangement.options.find((o) => o.templateId === 'way-home-a')?.key,
    );
    const ja = text(
      renderToStaticMarkup(<NeedScreen ctx={await app.ctx()} arrangementKey={arrangement.key} />),
    );
    expect(ja).toContain('この手で受け持てると確かめられない時間：13:00–15:00');
    expect(ja).toContain('おすすめ');
    // 「だれもいない」とは言わない（今の情報で示せないだけ）。
    expect(ja).not.toContain('受け持つ人がいません');
    const en = text(
      renderToStaticMarkup(
        <NeedScreen ctx={await app.ctx('en')} arrangementKey={arrangement.key} />,
      ),
    );
    expect(en).toContain('Time we can’t confirm this option would look after');
    expect(en).toContain('even if everyone agreed: 1:00 PM–3:00 PM');
  });

  it('どの手にも残る時間があれば、勧めず、その訳を書く（選ぶことはできる）', async () => {
    const app = family([tidy]);
    const arrangement = await app.stated(['way-tidy']);
    expect(arrangement.recommendedOptionKey).toBeUndefined();
    const ja = text(
      renderToStaticMarkup(<NeedScreen ctx={await app.ctx()} arrangementKey={arrangement.key} />),
    );
    expect(ja).toContain('どの手にも、選んで約束がそろっても受け持てると確かめられない時間がある');
    expect(ja).toContain('これに決める');
  });

  it('訳が混ざる時は、全部とは言わない（手ごとの印の行が、それぞれの訳を書く）', async () => {
    const app = family([tidy, homeA]);
    const arrangement = await app.stated(['way-tidy', 'way-home-a']);
    const ctx = await app.ctx();
    // 受け持てる手に「使わない」の印が付いた計画（訳の混ざる形）を、画面に渡す。
    const mixed = {
      ...arrangement,
      recommendedOptionKey: undefined,
      options: arrangement.options.map((o) =>
        o.templateId === 'way-home-a' ? { ...o, unusedResources: ['res-sick-care'] } : o,
      ),
    };
    const shown = text(
      renderToStaticMarkup(
        <NeedScreen
          ctx={{
            ...ctx,
            plan: {
              ...ctx.plan,
              arrangements: ctx.plan.arrangements.map((a) => (a.key === mixed.key ? mixed : a)),
            },
          }}
          arrangementKey={arrangement.key}
        />,
      ),
    );
    expect(shown).not.toContain('どの手にも');
    expect(shown).toContain('この手で受け持てると確かめられない時間：13:00–15:00');
    expect(shown).toContain('使わないとしています');
  });

  it('断られたらの仮の計算で、通用の「すること」には「間に合います」を書かない（勧めは出す）', async () => {
    const app = family([homeA]);
    const arrangement = await app.stated(['way-grandma', 'way-home-a']);
    const grandma = arrangement.options.find((o) => o.templateId === 'way-grandma');
    if (!grandma) throw new Error('祖母の案が無い');
    expect(
      await app.run({
        type: 'chooseOption',
        arrangementKey: arrangement.key,
        optionKey: grandma.key,
        role: 'primary',
        assigneeId: 'b',
      }),
    ).toMatchObject({ status: 'ok' });
    const view = viewFor(await app.events(), 'b', NOW);
    const ask = view.plan.tasks.find((t) => t.basis.optionKey === grandma.key && t.external);
    const shown = ask && proposalSnapshot(ask);
    if (!ask || !shown) throw new Error('頼む作業が無い');
    expect(await app.run({ type: 'accept', taskKey: ask.key, shown })).toMatchObject({
      status: 'ok',
    });
    expect(
      await app.run({
        type: 'recordSent',
        taskKey: ask.key,
        requestId: 'r-grandma',
        window: { start: arrangement.start, end: arrangement.end },
      }),
    ).toMatchObject({ status: 'ok' });
    const before = await app.events();
    const whatIf = previewChange(
      before,
      { memberId: 'b', now: NOW },
      { type: 'recordReply', requestId: 'r-grandma', reply: 'no' },
    );
    if ('reason' in whatIf) throw new Error(whatIf.reason);
    const ctx = await app.ctx();
    const current = ctx.plan.arrangements.find((a) => a.key === arrangement.key);
    if (!current) throw new Error('手配が無い');
    const out = text(
      renderToStaticMarkup(
        <WhatIfOutcome ctx={ctx} current={current} preview={whatIf} taskKey={ask.key} />,
      ),
    );
    // 残りの無い手（健太が家で立ち会う）を勧めるが、返事の期限で「間に合います」とは言わない。
    expect(out).toContain('選び直しになります。おすすめは「健太が家で立ち会う」です');
    expect(out).not.toContain('間に合います');
    // 仮の計算は何も書かない。
    expect(await app.events()).toEqual(before);
    // 頼む文にも、ほかの手の決め時から出した返事の期限を書かない（「すること」の日時は書く）。
    const draft = askDraft(ctx, ask);
    expect(draft).toContain('11月28日');
    expect(draft).not.toContain('お返事をもらえると助かります');
  });

  it('子の居場所の頼む文は、今までどおり返事の目安を書く', () => {
    const ctx = ctxFor('arrived', 'b', 'ja');
    const ask = ctx.plan.tasks.find(
      (t) =>
        t.external?.to === 'g' &&
        ctx.plan.arrangements.some(
          (a) => a.key === t.basis.arrangementKey && a.kind === 'childCare',
        ),
    );
    if (!ask) throw new Error('祖母に頼む作業が無い');
    expect(askDraft(ctx, ask)).toContain('お返事をもらえると助かります');
  });
});
