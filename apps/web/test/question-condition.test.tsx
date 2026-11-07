// 家にあるかの問いの札：条件しだいの持ち物は、確かに要る物として聞かず、その条件を書く。
import { DomainEvent, type TodayCard } from '@maniau/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { demoEvents } from '../../server/src/demo';
import { viewFor } from '../../server/src/views';
import i18n from '../src/i18n';
import { type Ctx, TodayScreen } from '../src/screens';
import { demoData } from './ctx';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

it('条件しだいの持ち物の問いには、その条件を書く', () => {
  const at = '2026-11-25T20:00+09:00';
  const events = [...demoEvents('arrived')];
  const add = (time: string, actorId: string, body: object) =>
    events.push(
      DomainEvent.parse({
        id: `q-${events.length + 1}`,
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
  const written = '発表会が12月5日なら、当日はハンカチを持たせてください。';
  add(at, 'b', {
    type: 'noticeReceived',
    source: {
      ...first.source,
      id: 'n3',
      title: 'ハンカチ',
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
          interpretation: { what: 'ハンカチ', date: '2026-12-05' },
          conditionNodeId: 'n3:c1',
          evidence: 'stated',
          effects: [],
        },
      ],
    },
  });
  const view = viewFor(events, 'b', at);
  const me = view.household.members.find((m) => m.id === 'b');
  if (!me) throw new Error('大人が無い');
  const ctx: Ctx = {
    plan: view.plan,
    household: view.household,
    today: { ...view.today, main: view.today.main.filter(isHandkerchief) },
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
  expect(ctx.today.main).toHaveLength(1);
  const shown = text(renderToStaticMarkup(<TodayScreen ctx={ctx} />));
  expect(shown).toContain('ハンカチは、家に用意できていますか？');
  expect(shown).toContain('学習発表会の実施日が12/5（土）なら要ります（まだ決まっていません）。');
});

function isHandkerchief(card: TodayCard): boolean {
  return card.kind === 'question' && card.question.unknownId === 'u-atHome:n3:i1';
}
