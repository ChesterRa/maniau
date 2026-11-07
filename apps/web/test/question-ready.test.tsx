// @vitest-environment happy-dom
// 持ち物の問いの言葉を変えても、家にあるかの答えの意味と見た版は変えない。
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import i18n from '../src/i18n';
import { type Ctx, TodayScreen } from '../src/screens';
import { step } from './fake-fetch';

it.each(['ja', 'en'] as const)(
  '用意の問いと二つの答えを画面の言葉で示し、元の答えを送る (%s)',
  async (lang) => {
    const requirement = {
      key: 'req:belongings:n1:i1',
      kind: 'belongings',
      what: 'お弁当',
      by: '2026-12-18T08:00+09:00',
      basis: { itemIds: ['n1:i1'] },
      live: true,
      atHomeUnknownId: 'u-atHome:n1:i1',
    };
    const question = { key: 'q:n1:i1', unknownId: requirement.atHomeUnknownId };
    const sent: unknown[] = [];
    const ctx = {
      household: {
        members: [{ id: 'a', kind: 'adult', name: '彩' }],
        places: [],
        careOptions: [],
        ways: [],
      },
      me: { id: 'a', kind: 'adult', name: '彩' },
      plan: {
        throughSeq: 7,
        requirements: [requirement],
        arrangements: [],
        tasks: [],
        requests: [],
        questions: [question],
      },
      today: { main: [{ kind: 'question' as const, question, requirement }], quiet: [] },
      items: [],
      sources: new Map(),
      readings: [],
      lang,
      tz: 'Asia/Tokyo',
      now: '2026-11-25T20:00+09:00',
      t: i18n.getFixedT(lang),
      outbound: (lng: string) => i18n.getFixedT(lng),
      go: () => {},
      send: async (command: unknown) => {
        sent.push(command);
        return { status: 'ok' as const };
      },
    } as unknown as Ctx;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await step(() => root.render(<TodayScreen ctx={ctx} />));
      expect(host.textContent).toContain(ctx.t('card.question.atHome', { what: requirement.what }));
      for (const key of ['card.question.ready', 'card.question.notReady']) {
        const button = [...host.querySelectorAll('button')].find(
          (b) => b.textContent === ctx.t(key),
        );
        expect(button).toBeDefined();
        await step(() => button?.click());
      }
      expect(sent).toEqual(
        ['yes', 'no'].map((value) => ({
          type: 'answer',
          unknownId: question.unknownId,
          value,
          seen: { what: requirement.what, throughSeq: ctx.plan.throughSeq },
        })),
      );
    } finally {
      await step(() => root.unmount());
      host.remove();
    }
  },
);
