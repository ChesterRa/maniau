// このままでは無理の札：登録した手立てでは間に合う方法が見つからない時、探した範囲で見つからなかったと
// 書き、ほかの手を考えてもらう。買い物は、ほかの手で用意できたら「用意できた」で閉じる。
import { type Command, DomainEvent, type TodayCard } from '@maniau/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { demoEvents } from '../../server/src/demo';
import { viewFor } from '../../server/src/views';
import i18n from '../src/i18n';
import { type Ctx, SourcesScreen, StuckCard, TodayScreen } from '../src/screens';
import { ctxFor, demoData } from './ctx';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const LATE = '2026-12-04T20:50+09:00';
const UNKNOWN = 'u-atHome:n1:i5';

/** 家に無いと答え、最後の買い物の機会も過ぎた後の、その大人の画面の材料。 */
function notAtHome(
  memberId: string,
  lang: 'ja' | 'en',
  sent: Command[] = [],
  deadline?: string,
): Ctx {
  const events = [...demoEvents('arrived')];
  if (deadline) {
    events.push(
      DomainEvent.parse({
        id: 'fix-deadline',
        householdId: events[0]?.householdId,
        seq: events.length + 1,
        version: 1,
        occurredAt: '2026-12-04T20:00+09:00',
        recordedAt: '2026-12-04T20:00+09:00',
        actorId: 'a',
        type: 'itemCorrected',
        itemId: 'n1:i5',
        interpretation: { deadline },
      }),
    );
  }
  events.push(
    DomainEvent.parse({
      id: 'no-at-home',
      householdId: events[0]?.householdId,
      seq: events.length + 1,
      version: 1,
      occurredAt: LATE,
      recordedAt: LATE,
      actorId: 'b',
      type: 'answered',
      unknownId: UNKNOWN,
      value: 'no',
    }),
  );
  const view = viewFor(events, memberId, LATE);
  const me = view.household.members.find((m) => m.id === memberId);
  if (!me) throw new Error('大人が無い');
  return {
    plan: view.plan,
    household: view.household,
    today: view.today,
    items: view.items,
    sources: new Map(view.sources.map((s) => [s.id, s])),
    readings: demoData.readings,
    me,
    lang,
    tz: view.household.timeZone,
    now: view.now,
    t: i18n.getFixedT(lang),
    outbound: (lng) => i18n.getFixedT(lng),
    send: async (command) => {
      sent.push(command);
      return { status: 'ok' };
    },
    go: () => {},
  };
}

const stuckOf = (ctx: Ctx, kind: 'purchase' | 'childCare') =>
  ctx.today.main.find(
    (c): c is Extract<TodayCard, { kind: 'stuck' }> =>
      c.kind === 'stuck' && c.arrangement.kind === kind,
  );

describe('このままでは無理の札', () => {
  it('買い物：探した範囲で見つからなかったと書き、二人に出す（日英）', () => {
    for (const member of ['a', 'b']) {
      const shown = text(renderToStaticMarkup(<TodayScreen ctx={notAtHome(member, 'ja')} />));
      expect(shown, member).toContain('このままでは間に合いません');
      expect(shown, member).toContain('白い長袖シャツ');
      expect(shown, member).toContain(
        '12/5（土）までに要りますが、登録した帰り道と店では、買える時が見つかりませんでした。',
      );
      expect(shown, member).toContain('用意できた');
    }
    const en = text(renderToStaticMarkup(<TodayScreen ctx={notAtHome('b', 'en')} />));
    expect(en).toContain('No way found in time');
    expect(en).toContain('no time to buy it was found on your registered routes and stores');
    expect(en).toContain('Got it');
  });

  it('子の居場所：その日と、ほかの手を家族で考えることを書く（ボタンは出さない）', () => {
    const ctx = ctxFor('arrived', 'a', 'ja', '2026-12-05T08:30+09:00');
    const card = stuckOf(ctx, 'childCare');
    if (!card) throw new Error('札が無い');
    const shown = text(renderToStaticMarkup(<StuckCard ctx={ctx} card={card} />));
    expect(shown).toContain('このままでは間に合いません');
    expect(shown).toContain('登録した手立てと決め時では、決められませんでした。');
    // 条件しだいの手配は、確かに要る物として見せない（その条件を書く）。
    expect(shown).toContain('学習発表会の実施日が12/5（土）なら要ります（まだ決まっていません）。');
    expect(shown).not.toContain('用意できた');
  });

  it('条件しだいの買い物も、その条件を書く', () => {
    const at = '2026-11-25T20:00+09:00';
    const events = [...demoEvents('arrived')];
    const add = (time: string, actorId: string, body: object) =>
      events.push(
        DomainEvent.parse({
          id: `c-${events.length + 1}`,
          householdId: events[0]?.householdId,
          seq: events.length + 1,
          version: 1,
          occurredAt: time,
          recordedAt: time,
          actorId,
          ...body,
        }),
      );
    const first = events.find((e) => e.type === 'noticeReceived');
    if (first?.type !== 'noticeReceived') throw new Error('お知らせが無い');
    const written = '発表会が12月5日なら、当日は体操服を持たせてください。';
    add(at, 'b', {
      type: 'noticeReceived',
      source: {
        ...first.source,
        id: 'n3',
        title: '体操服',
        sentences: [{ id: 'n3#1', text: written }],
      },
    });
    add(at, 'system', {
      type: 'modelOutputRecorded',
      call: 'extract',
      sourceId: 'n3',
      model: 'hand-written',
      promptVersion: 'fixture',
      inputHash: 'n3',
      output: {
        sourceId: 'n3',
        unknowns: [],
        irrelevantSentenceIds: [],
        ambiguities: [],
        conditions: [{ id: 'n3:c1', kind: 'eq', unknownId: 'n1:u1', value: '2026-12-05' }],
        items: [
          {
            id: 'n3:i1',
            sourceId: 'n3',
            sentenceIds: ['n3#1'],
            kind: 'belongings',
            written,
            interpretation: { what: '体操服', date: '2026-12-05' },
            conditionNodeId: 'n3:c1',
            evidence: 'stated',
            effects: [],
          },
        ],
      },
    });
    add(LATE, 'b', { type: 'answered', unknownId: 'u-atHome:n3:i1', value: 'no' });
    const view = viewFor(events, 'b', LATE);
    const me = view.household.members.find((m) => m.id === 'b');
    if (!me) throw new Error('大人が無い');
    const ctx: Ctx = {
      plan: view.plan,
      household: view.household,
      today: view.today,
      items: view.items,
      sources: new Map(view.sources.map((s) => [s.id, s])),
      readings: demoData.readings,
      me,
      lang: 'ja',
      tz: view.household.timeZone,
      now: view.now,
      t: i18n.getFixedT('ja'),
      outbound: (lng) => i18n.getFixedT(lng),
      send: async () => ({ status: 'ok' }),
      go: () => {},
    };
    const card = ctx.today.main.find(
      (c): c is Extract<TodayCard, { kind: 'stuck' }> =>
        c.kind === 'stuck' && c.arrangement.key === 'arr:purchase:n3:i1',
    );
    if (!card) throw new Error('札が無い');
    const shown = text(renderToStaticMarkup(<StuckCard ctx={ctx} card={card} />));
    expect(shown).toContain('体操服');
    expect(shown).toContain('学習発表会の実施日が12/5（土）なら要ります（まだ決まっていません）。');
  });

  it('札の出ている手配の原文の文は「計画に入れました」と印を付ける', () => {
    const html = renderToStaticMarkup(<SourcesScreen ctx={notAtHome('b', 'ja')} sourceId="n1" />);
    const line = html
      .split('<p')
      .map(text)
      .find((p) => p.includes('白い長袖シャツを用意してください'));
    expect(line).toContain('計画に入れました');
  });

  it('お知らせや家族が時刻まで書いた締切は、日と時刻を書く（日だけの物は日だけ）', () => {
    const exact = text(
      renderToStaticMarkup(
        <TodayScreen ctx={notAtHome('b', 'ja', [], '2026-12-04T22:30+09:00')} />,
      ),
    );
    expect(exact).toContain('22:30までに要りますが');
    const dayOnly = text(renderToStaticMarkup(<TodayScreen ctx={notAtHome('b', 'ja')} />));
    expect(dayOnly).toContain('12/5（土）までに要りますが');
    expect(dayOnly).not.toContain('8:00');
  });
});
