// ひとことで「家にあるか」に答える候補は、問いの札と同じ言葉で、画面の言葉で書く（日英）。要る日を添え、
// 同じ品物が別の日にも要る時に、どちらに答えるかを見分けられるようにする。
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { demoSessions } from '../../server/src/demo-sessions';
import type { View } from '../../server/src/views';
import type { Heard } from '../src/family';
import i18n from '../src/i18n';
import { type Ctx, SayReply, TodayScreen } from '../src/screens';
import { demoData } from './ctx';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

async function ctxOf(lang: 'ja' | 'en', more?: string): Promise<Ctx> {
  const sessions = demoSessions();
  const id = sessions.create('arrived');
  if (more) await addShirtNotice(sessions, id, more);
  const view = (await sessions.view(id, 'b')) as View;
  const me = view.household.members.find((m) => m.id === 'b');
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
    send: async () => ({ status: 'ok' }),
    go: () => {},
  };
}

/** 同じ品物を別の日に持って行くお知らせを足す（読み取りは偽物）。 */
async function addShirtNotice(
  sessions: ReturnType<typeof demoSessions>,
  id: string,
  date: string,
): Promise<void> {
  const text = `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日は白い長袖シャツを持ってきてください。`;
  const added = await sessions.notice(
    id,
    'b',
    { text, sender: 'school', operationId: 'notice-shirt' },
    async (request) => ({
      output: {
        items: [
          {
            id: 'i1',
            sentenceIds: [request.source.sentences[0]?.id ?? ''],
            kind: 'belongings',
            written: text,
            date,
            writtenWeekday: 'none',
            startTime: null,
            endTime: null,
            what: '白い長袖シャツ',
            dayType: null,
            deadline: null,
            audience: null,
            place: null,
            relativeDay: 'none',
            conditionNodeId: null,
            inferred: false,
            effects: [],
          },
        ],
        unknowns: [],
        conditions: [],
        irrelevantSentenceIds: [],
        ambiguities: [],
      },
      model: 'test-model',
      promptVersion: 'test',
      inputHash: 'test',
      usage: { input_tokens: 0, output_tokens: 0 },
    }),
  );
  if (added?.status !== 'ok') throw new Error('お知らせを足せない');
}

const replyTo = (unknownId: string): Heard => ({
  kind: 'change',
  proposals: [
    {
      id: 'p-1',
      command: {
        type: 'answer',
        unknownId,
        value: 'no',
        seen: { what: '白い長袖シャツ', throughSeq: 0 },
      },
    },
  ],
});
const reply = replyTo('u-atHome:n1:i5');
const render = (ctx: Ctx, heard: Heard) =>
  text(
    renderToStaticMarkup(
      <SayReply ctx={ctx} reply={heard} busy={false} onRecord={() => {}} onClear={() => {}} />,
    ),
  );

it('家にあるかの答えの候補は、問いの札と同じ言葉で、要る日を添えて書く', async () => {
  expect(render(await ctxOf('ja'), reply)).toContain(
    '白い長袖シャツはありますか？（12/5（土）までに要る）：「ない」と答える',
  );
  const en = render(await ctxOf('en'), reply);
  expect(en).toContain('Do you have 白い長袖シャツ at home?');
  expect(en).toContain('(needed by');
});

it('同じ品物が別の日にも要る時は、どちらに答えるかを日で見分けられる', async () => {
  const ctx = await ctxOf('ja', '2026-12-14');
  const shirts = ctx.plan.requirements.filter((r) => r.live && r.what === '白い長袖シャツ');
  expect(shirts).toHaveLength(2);
  const labels = shirts.map((r) => render(ctx, replyTo(r.atHomeUnknownId ?? '')));
  expect(labels.find((l) => l.includes('（12/5（土）までに要る）'))).toBeDefined();
  expect(labels.find((l) => l.includes('（12/14（月）までに要る）'))).toBeDefined();
});

it('同じ品物を同じ日に求めるお知らせが二つあれば、一つだけの候補でも記録させず、札から答えてもらう', async () => {
  const ctx = await ctxOf('ja', '2026-12-05');
  const shirts = ctx.plan.requirements.filter((r) => r.live && r.what === '白い長袖シャツ');
  expect(shirts).toHaveLength(2);
  for (const shirt of shirts) {
    const shown = render(ctx, replyTo(shirt.atHomeUnknownId ?? ''));
    expect(shown).toContain('どれに答えるか見分けられません');
    expect(shown).not.toContain('記録する');
  }
  // 別の日なら、日で見分けられるので記録できる。
  expect(render(await ctxOf('ja', '2026-12-14'), reply)).toContain('記録する');
});

it('同じ品物を同じ日に求める二つの問いの札は、どのお知らせの物かで見分けられる', async () => {
  const ctx = await ctxOf('ja', '2026-12-05');
  const shirts = ctx.plan.requirements.filter((r) => r.live && r.what === '白い長袖シャツ');
  const titles = shirts.map((r) => {
    const item = ctx.items.find((l) => r.basis.itemIds.includes(l.item.id))?.item;
    return item ? ctx.sources.get(item.sourceId)?.title : undefined;
  });
  expect(new Set(titles).size).toBe(2);
  const shown = text(renderToStaticMarkup(<TodayScreen ctx={ctx} />));
  for (const title of titles) expect(shown).toContain(`「${title}」の文を見る`);
});
