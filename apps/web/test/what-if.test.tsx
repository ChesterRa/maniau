// 「断られたら？」（W5）：返事待ちの行と予備の札から開き、断られたと仮に置いた計算（サーバーと同じ見る口の結果）を
// 見せる。仮の計算だと書き、何も送らない。選び直しなら、勧める手と、いつまでに返事をもらえば間に合うかを見せる。
import type { HouseholdPreview, SaveablePreview } from '@maniau/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEMO_STAGES, demoEvents } from '../../server/src/demo';
import { previewChange } from '../../server/src/preview';
import { viewFor } from '../../server/src/views';
import { type Ctx, TodayScreen } from '../src/screens';
import { WhatIfOutcome, WhatIfScreen } from '../src/what-if';
import { ctxFor } from './ctx';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ');
const no = { type: 'recordReply', requestId: 'r-grandma', reply: 'no' } as const;

/** サーバーの見る口と同じ計算（書き込まない）。 */
function previewFor(stage: 'asked' | 'backup'): HouseholdPreview {
  const now = DEMO_STAGES.find((s) => s.id === stage)?.now ?? '';
  const shown = previewChange(demoEvents(stage), { memberId: 'b', now }, no);
  if ('reason' in shown) throw new Error(`計算できない：${shown.reason}`);
  return shown;
}

function outcome(stage: 'asked' | 'backup', lang: 'ja' | 'en' = 'ja') {
  const ctx = ctxFor(stage, 'b', lang);
  const request = ctx.plan.requests.find((r) => r.requestId === 'r-grandma');
  const current = ctx.plan.arrangements.find((a) => a.key === request?.basis.arrangementKey);
  if (!request || !current) throw new Error('依頼か手配が無い');
  return text(
    renderToStaticMarkup(
      <WhatIfOutcome
        ctx={ctx}
        current={current}
        preview={previewFor(stage)}
        taskKey={request.taskKey}
      />,
    ),
  );
}

describe('断られたら？', () => {
  it('返事待ちの頼み事がある「きょう」に、「断られたら？」を出す', () => {
    const shown = text(renderToStaticMarkup(<TodayScreen ctx={ctxFor('asked', 'b', 'ja')} />));
    expect(shown).toContain('断られたら？');
  });

  it('画面は、仮の計算で何も記録・送信しないと書いてから、計算を待つ', () => {
    const ctx: Ctx = { ...ctxFor('asked', 'b', 'ja'), previewChange: () => new Promise(() => {}) };
    const shown = text(renderToStaticMarkup(<WhatIfScreen ctx={ctx} requestId="r-grandma" />));
    expect(shown).toContain('おばあちゃんに断られたら');
    expect(shown).toContain('仮の計算');
    expect(shown).toContain('ここでは何も記録せず、だれにも送りません');
    expect(shown).toContain('計算しています');
  });

  it('選び直しなら、勧める手と、いつまでに返事をもらえば間に合うか、残る手の決め時を見せる', () => {
    const shown = outcome('asked');
    expect(shown).toContain('選び直しになります。おすすめは「学童に預ける」です');
    expect(shown).toMatch(/の夜までに返事をもらえれば、断られても「学童に預ける」に間に合います/);
    // 残る手（断られた手は数えない）。
    expect(shown).toContain('いま選べる手は3つ');
  });

  it('予備を押さえた後なら、予備に進むことと増える作業を見せる', () => {
    const shown = outcome('backup');
    expect(shown).toContain('予備の「学童に預ける」に進みます');
    expect(shown).toContain('変わること');
    expect(shown).toContain('新しい作業：お弁当の材料を買う');
    expect(shown).not.toContain('選び直しになります');
    // 何も保存しない仮の計算なので、決める画面の「選んだら」と同じく、確かめきれない点の数は出さない。
    expect(shown).not.toContain('確かめきれない点');
  });

  it('断られるのが予備（学童）の時は、本命のおばあちゃんのまま進み、予備が使えなくなると書く', () => {
    // 学童に頼んで、返事（はい）を記録する前の時点（デモの「11/30 学童にも申し込んだ」の最後の返事の前）。
    const all = demoEvents('backup');
    expect(all.at(-1)?.type).toBe('externalReplyRecorded');
    const events = all.slice(0, -1);
    const now = DEMO_STAGES.find((s) => s.id === 'backup')?.now ?? '';
    const view = viewFor(events, 'a', now);
    const ctx: Ctx = { ...ctxFor('backup', 'a', 'ja'), plan: view.plan, today: view.today };
    const request = ctx.plan.requests.find((r) => r.requestId === 'r-gakudo');
    const current = ctx.plan.arrangements.find((a) => a.key === request?.basis.arrangementKey);
    if (!request || !current) throw new Error('依頼か手配が無い');
    expect(request.state).toBe('awaitingReply');
    expect(text(renderToStaticMarkup(<TodayScreen ctx={ctx} />))).toContain('断られたら？');
    const preview = previewChange(
      events,
      { memberId: 'a', now },
      { type: 'recordReply', requestId: 'r-gakudo', reply: 'no' },
    );
    if ('reason' in preview) throw new Error(preview.reason);
    const shown = text(
      renderToStaticMarkup(
        <WhatIfOutcome ctx={ctx} current={current} preview={preview} taskKey={request.taskKey} />,
      ),
    );
    expect(shown).toContain('今の「おばあちゃんに頼む」のまま進みます');
    expect(shown).toContain('予備の「学童に預ける」は使えなくなります');
    expect(shown).not.toContain('予備の「おばあちゃんに頼む」に進みます');
  });

  it('この画面には、本当に記録する操作（予備を押さえる等）を置かない', () => {
    const ctx: Ctx = { ...ctxFor('chase', 'b', 'ja'), previewChange: () => new Promise(() => {}) };
    const shown = text(renderToStaticMarkup(<WhatIfScreen ctx={ctx} requestId="r-grandma" />));
    // 「きょう」の予備の札（押すと本当に選ぶ）は出さない。ほかの手を見る口だけ。
    expect(shown).not.toContain('自分でやる');
    expect(shown).toContain('ほかの手も見る・選び直す');
  });

  it('英語でも同じ物を出す', () => {
    const shown = outcome('asked', 'en');
    expect(shown).toContain('choose again');
    expect(shown).not.toMatch(/whatIf\.|\{\{/);
  });

  it('もう返事を待っていない依頼では計算せず、そう書く', () => {
    const ctx = ctxFor('asked', 'b', 'ja');
    const answered: Ctx = {
      ...ctx,
      plan: {
        ...ctx.plan,
        requests: ctx.plan.requests.map((r) =>
          r.requestId === 'r-grandma' ? { ...r, state: 'confirmed' } : r,
        ),
      },
    };
    const shown = text(renderToStaticMarkup(<WhatIfScreen ctx={answered} requestId="r-grandma" />));
    expect(shown).toContain('おばあちゃんへの頼み事は、もう返事を待っていません');
    expect(shown).not.toContain('計算しています');
  });

  it('保存の命令の型は、返事の仮定を含まない（見るだけで、保存の道に乗らない）', () => {
    const saveable: SaveablePreview['type'][] = [
      'updateHousehold',
      'stateNeed',
      'setNeedWays',
      'correctItem',
      'dismissItem',
    ];
    expect(saveable).not.toContain('recordReply');
  });
});
