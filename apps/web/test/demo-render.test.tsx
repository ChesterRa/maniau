// デモの全ての段を、大人ごと・言葉ごとに、サーバーと同じ見せる物で描いてみる。落ちず、文言のキーが
// そのまま出ないこと（画面の煙の試験。操作の正しさはサーバーの試験が受け持つ）。
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEMO_STAGES } from '../../server/src/demo';
import { AskScreen, DecideScreen, SourcesScreen, TodayScreen, WeekScreen } from '../src/screens';
import { ctxFor, demoData } from './ctx';

const RAW_KEY =
  /\b(?:card|today|decide|ask|quiet|week|sources|draft|option|task|cost|notice|demo|answer|missing|condition|say)\.[a-zA-Z]/;

const text = (html: string) => html.replace(/<[^>]+>/g, ' ');

describe('デモの画面', () => {
  const adults = demoData.household.members.filter((m) => m.kind === 'adult');
  for (const stage of DEMO_STAGES) {
    for (const me of adults) {
      for (const lang of ['ja', 'en'] as const) {
        it(`${stage.id}・${me.id}・${lang}`, () => {
          const ctx = ctxFor(stage.id, me.id, lang);
          const pages = [
            <TodayScreen key="today" ctx={ctx} />,
            <WeekScreen key="week" ctx={ctx} />,
            <SourcesScreen key="sources" ctx={ctx} />,
            ...ctx.plan.arrangements.map((a) => (
              <DecideScreen key={a.key} ctx={ctx} arrangementKey={a.key} />
            )),
            ...ctx.plan.tasks
              .filter((t) => t.external)
              .map((t) => <AskScreen key={t.key} ctx={ctx} taskKey={t.key} />),
          ];
          for (const page of pages) {
            const shown = text(renderToStaticMarkup(page));
            expect(shown).not.toMatch(RAW_KEY);
            expect(shown).not.toContain('{{');
          }
        });
      }
    }
  }
});
