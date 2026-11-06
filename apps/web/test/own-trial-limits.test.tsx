// 名前だけの家族の試用で、計算していない事を言わない・次にすることを言う：買う時を置けない買い物は「間に合わない」と
// 言わず（エンジンは「決められない」）、試用では駅や帰り道を入れられないこと、見本の家族で見られることを書く。頼める人
// だけを足せること、日を決めた後にやり方を選ぶことも書く。本当に過ぎた買い物は、今までどおり「間に合わない」と言う。
import { DomainEvent, type TodayCard } from '@maniau/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  demoEvents,
  exampleNotice,
  ownHousehold,
  TRIAL_NOW,
  trialEvents,
} from '../../server/src/demo';
import { viewFor } from '../../server/src/views';
import { CareOptionAddCard } from '../src/facts';
import i18n from '../src/i18n';
import { type Ctx, StuckCard } from '../src/screens';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const SHIRT = 'u-atHome:n1:i5';

/** 名前だけの家族に例のお知らせを入れ、白シャツに「無い」と答えた事象（試用の画面と同じ順）。 */
function ownEvents(): DomainEvent[] {
  const household = ownHousehold({ adults: ['大人A', '大人B'], child: 'そら' });
  const events = trialEvents(household);
  const { source, output, extraction } = exampleNotice();
  const add = (at: string, actorId: string, body: Record<string, unknown>) =>
    events.push(
      DomainEvent.parse({
        id: `own-${events.length + 1}`,
        householdId: household.id,
        seq: events.length + 1,
        version: 1,
        occurredAt: at,
        recordedAt: at,
        actorId,
        ...body,
      }),
    );
  add(source.receivedAt, 'a1', { type: 'noticeReceived', source });
  add(source.receivedAt, 'system', {
    type: 'modelOutputRecorded',
    call: 'extract',
    ...output,
    sourceId: source.id,
    sourceVersion: 1,
    output: extraction,
  });
  add(TRIAL_NOW, 'a1', { type: 'answered', unknownId: SHIRT, value: 'no' });
  return events;
}

function ctxOf(
  events: DomainEvent[],
  memberId: string,
  now: string,
  lang: 'ja' | 'en',
  ownTrial: boolean,
): Ctx {
  const view = viewFor(events, memberId, now);
  const me = view.household.members.find((m) => m.id === memberId);
  if (!me) throw new Error('大人が無い');
  return {
    plan: view.plan,
    household: view.household,
    today: view.today,
    items: view.items,
    sources: new Map(view.sources.map((s) => [s.id, s])),
    readings: [exampleNotice().reading],
    me,
    lang,
    tz: view.household.timeZone,
    now: view.now,
    t: i18n.getFixedT(lang),
    outbound: (lng) => i18n.getFixedT(lng),
    send: async () => ({ status: 'ok' }),
    go: () => {},
    ...(ownTrial ? { ownTrial: true as const } : {}),
  };
}

const purchaseStuck = (ctx: Ctx) => {
  const card = ctx.today.main.find(
    (c): c is Extract<TodayCard, { kind: 'stuck' }> =>
      c.kind === 'stuck' && c.arrangement.kind === 'purchase',
  );
  if (!card) throw new Error('買い物の札が無い');
  return card;
};

describe('名前だけの家族の試用：買う時を置けない買い物', () => {
  it('「間に合わない」と言わず、決められないと書き、試用でできない事と見本の家族を示す（日英）', () => {
    const ja = ctxOf(ownEvents(), 'a1', TRIAL_NOW, 'ja', true);
    const card = purchaseStuck(ja);
    // エンジンは「決められない」とする（過ぎた最後の機会を示せない）。
    expect(card.arrangement.status).toBe('undetermined');
    const shown = text(renderToStaticMarkup(<StuckCard ctx={ja} card={card} />));
    expect(shown).toContain('買う時をまだ決められません');
    expect(shown).toContain(
      '今入っている家の情報では、寄って買える時を決められませんでした。間に合わないと決まったのではありません。',
    );
    expect(shown).toContain('この試用では、駅や帰り道を入れられません。');
    expect(shown).toContain('見本の家族で見られます');
    expect(shown).toContain('この試用は終わり、記録は移りません');
    expect(shown).toContain('用意できた');
    expect(shown).not.toContain('このままでは間に合いません');

    const en = ctxOf(ownEvents(), 'a1', TRIAL_NOW, 'en', true);
    const shownEn = text(renderToStaticMarkup(<StuckCard ctx={en} card={purchaseStuck(en)} />));
    expect(shownEn).toContain('Can’t plan when to buy yet');
    expect(shownEn).toContain('This doesn’t mean it’s too late.');
    expect(shownEn).toContain('You can’t enter stations or routes in this trial.');
    expect(shownEn).toContain('Got it');
    expect(shownEn).not.toContain('No way found in time');
  });

  it('試用でなければ、試用の説明と見本の家族は出さない（決められないとだけ書く）', () => {
    const ctx = ctxOf(ownEvents(), 'a1', TRIAL_NOW, 'ja', false);
    const shown = text(renderToStaticMarkup(<StuckCard ctx={ctx} card={purchaseStuck(ctx)} />));
    expect(shown).toContain('買う時をまだ決められません');
    expect(shown).not.toContain('この試用では');
    expect(shown).not.toContain('見本の家族');
  });

  it('見本の家族で、最後の機会が過ぎた買い物は、今までどおり「間に合わない」と言う', () => {
    const late = '2026-12-04T20:50+09:00';
    const events = [...demoEvents('arrived')];
    events.push(
      DomainEvent.parse({
        id: 'no-at-home',
        householdId: events[0]?.householdId,
        seq: events.length + 1,
        version: 1,
        occurredAt: late,
        recordedAt: late,
        actorId: 'b',
        type: 'answered',
        unknownId: SHIRT,
        value: 'no',
      }),
    );
    const ctx = ctxOf(events, 'b', late, 'ja', false);
    const card = purchaseStuck(ctx);
    expect(card.arrangement.status).toBe('infeasible');
    const shown = text(renderToStaticMarkup(<StuckCard ctx={ctx} card={card} />));
    expect(shown).toContain('このままでは間に合いません');
    expect(shown).not.toContain('買う時をまだ決められません');
    // 同じ札が「決められない」になった時（店はあるが寄れる時が無い）も、試用でなければ試用の説明は出さない。
    const undecided = {
      ...card,
      arrangement: { ...card.arrangement, status: 'undetermined' as const },
    };
    const shownUndecided = text(renderToStaticMarkup(<StuckCard ctx={ctx} card={undecided} />));
    expect(shownUndecided).toContain('買う時をまだ決められません');
    expect(shownUndecided).not.toContain('このままでは間に合いません');
    expect(shownUndecided).not.toContain('この試用では');
  });
});

describe('名前だけの家族の試用：取れる手を足す所', () => {
  it('試用でも、頼める人・学童・休みの三つから選んで足せる（日英）。頼める人だけとは書かない', () => {
    const ja = ctxOf(ownEvents(), 'a1', TRIAL_NOW, 'ja', true);
    const shown = text(renderToStaticMarkup(<CareOptionAddCard ctx={ja} />));
    for (const kind of ['頼める人', '学童', '休み']) expect(shown).toContain(kind);
    expect(shown).not.toContain('頼める人だけ');
    const en = ctxOf(ownEvents(), 'a1', TRIAL_NOW, 'en', true);
    const english = text(renderToStaticMarkup(<CareOptionAddCard ctx={en} />));
    for (const kind of ['Someone to ask', 'After-school care', 'Time off'])
      expect(english).toContain(kind);
    expect(english).not.toContain('the only childcare way');
  });
});
