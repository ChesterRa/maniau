// 書かれた日の無い架空のお知らせを、サーバーの読み取り・確認・再計画の道で確かめる。
// モデルの応答は固定し、外部 API は使わない。
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { demoSessions } from '../../server/src/demo-sessions';
import type { View } from '../../server/src/views';
import i18n from '../src/i18n';
import { type Ctx, TodayScreen } from '../src/screens';

function context(view: View, lang: 'ja' | 'en'): Ctx {
  const me = view.household.members.find((member) => member.id === 'b');
  if (!me) throw new Error('大人が無い');
  return {
    plan: view.plan,
    household: view.household,
    today: view.today,
    items: view.items,
    sources: new Map(view.sources.map((source) => [source.id, source])),
    readings: view.readings.map((reading) => ({ ...reading, origin: 'live' as const })),
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

it('あしたの持ち物を、確かめる前はきょうから原文へ、確かめた後は計画へ', async () => {
  const sessions = demoSessions();
  const id = sessions.create('arrived');
  const text = 'あした、運動靴を持ってきてください。';
  const read = await sessions.notice(
    id,
    'b',
    { text, sender: 'school', operationId: 'read-shoes' },
    async (request) => ({
      output: {
        items: [
          {
            id: 'i1',
            sentenceIds: [request.source.sentences[0]?.id ?? ''],
            kind: 'belongings',
            written: text,
            date: null,
            writtenWeekday: 'none',
            startTime: null,
            endTime: null,
            what: '運動靴',
            dayType: null,
            deadline: null,
            audience: null,
            place: null,
            relativeDay: 'tomorrow',
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
      model: 'fixture',
      promptVersion: 'test',
      inputHash: 'test',
      usage: { input_tokens: 0, output_tokens: 0 },
    }),
  );
  if (read?.status !== 'ok') throw new Error('読み取りを記録できない');
  const entry = read.view.items.find(({ item }) => item.sourceId === read.sourceId);
  expect(entry).toMatchObject({
    trusted: false,
    item: { interpretation: { date: '2026-11-26', relativeDayFromReceived: '2026-11-25' } },
  });
  expect(read.view.plan.requirements.some((r) => r.what === '運動靴')).toBe(false);
  for (const lang of ['ja', 'en'] as const) {
    const ctx = context(read.view, lang);
    const shown = renderToStaticMarkup(<TodayScreen ctx={ctx} />);
    expect(shown).toContain(ctx.t('today.checkDates.open', { what: '運動靴' }));
  }
  if (!entry) throw new Error('事項が無い');
  const command = {
    type: 'correctItem' as const,
    itemId: entry.item.id,
    interpretation: { date: '2026-11-26' },
  };
  const preview = await sessions.changePreview(id, 'b', command);
  if (!preview || 'reason' in preview) throw new Error('変更を見られない');
  const saved = await sessions.command(id, 'b', 'confirm-shoes', {
    ...command,
    seen: { throughSeq: preview.throughSeq, changes: preview.seen },
  });
  expect(saved?.result.status).toBe('ok');
  if (!saved) throw new Error('保存できない');
  expect(saved.view.items.find(({ item }) => item.id === entry.item.id)?.trusted).toBe(true);
  expect(saved.view.plan.requirements.some((r) => r.what === '運動靴')).toBe(true);
  const after = context(saved.view, 'ja');
  expect(renderToStaticMarkup(<TodayScreen ctx={after} />)).not.toContain(
    after.t('today.checkDates.open', { what: '運動靴' }),
  );
});
