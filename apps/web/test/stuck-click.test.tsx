// @vitest-environment happy-dom
// このままでは無理の札（買い物）：「用意できた」は、家にあるかの値に「ある」と答える命令を送る。
import type { Command, TodayCard } from '@maniau/core';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import i18n from '../src/i18n';
import { StuckCard } from '../src/screens';
import { step } from './fake-fetch';

it('「用意できた」は、家にあるかの値に「ある」と答える', async () => {
  const sent: Command[] = [];
  const card: Extract<TodayCard, { kind: 'stuck' }> = {
    kind: 'stuck',
    arrangement: {
      key: 'arr:purchase:n1:i5',
      requirementKey: 'req:belongings:n1:i5',
      kind: 'purchase',
      atHomeUnknownId: 'u-atHome:n1:i5',
      start: '2026-12-04T20:50+09:00',
      end: '2026-12-05T08:00+09:00',
      status: 'infeasible',
      options: [],
      backupOptionKeys: [],
      reasons: [{ code: 'noOptionLeft', refs: [] }],
      live: true,
    },
    requirement: {
      key: 'req:belongings:n1:i5',
      kind: 'belongings',
      what: '白い長袖シャツ',
      by: '2026-12-05T08:00+09:00',
      nature: 'required',
      basis: { itemIds: ['n1:i5'] },
      live: true,
    },
  };
  const ctx = {
    lang: 'ja',
    tz: 'Asia/Tokyo',
    household: { members: [] },
    plan: { requirements: [card.requirement], arrangements: [card.arrangement], throughSeq: 7 },
    items: [],
    t: i18n.getFixedT('ja'),
    send: async (command: Command) => {
      sent.push(command);
      return { status: 'ok' };
    },
  } as never;
  const host = document.createElement('div');
  const root = createRoot(host);
  await step(() => root.render(<StuckCard ctx={ctx} card={card} />));
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === '用意できた');
  expect(button).toBeDefined();
  await step(() => button?.click());
  expect(sent).toEqual([
    {
      type: 'answer',
      unknownId: 'u-atHome:n1:i5',
      value: 'yes',
      seen: { what: '白い長袖シャツ', throughSeq: 7 },
    },
  ]);
  await step(() => root.unmount());
});
