// 架空の通知の読み取りを確かめ、未回答の条件や未確定の変更がある時の通知を調べる。API は呼ばない。
import {
  type Command,
  ExtractionOutput,
  notificationHistory,
  notificationIntents,
  type PreviewCommand,
  Source,
  toExtraction,
} from '@maniau/core';
import { computePlan, currentItems, foldEvents } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { sendGate } from '../src/gate';
import { previewChange } from '../src/preview';
import { memoryStore } from '../src/store';

async function checkConditional(changeKind?: 'cancel' | 'replace') {
  const now = '2026-11-25T20:00+09:00';
  const store = memoryStore(new Map([['demo', demoEvents('arrived')]]));
  const events = () => store.withHousehold('demo', (log) => [...log.events()]);
  const text = changeKind
    ? '12月4日までに申し込んでください。'
    : '来年度も利用する家庭は12月4日までに申し込んでください。';
  await store.withHousehold('demo', (log) => {
    log.append(
      [
        {
          type: 'noticeReceived',
          source: {
            id: 'audit-source',
            version: 1,
            receivedAt: now,
            sender: 'school',
            language: 'ja',
            medium: 'text',
            sentences: [{ id: 'audit-s', text }],
          },
        },
      ],
      'b',
      now,
    );
    log.append(
      [
        {
          type: 'modelOutputRecorded',
          call: 'extract',
          model: 'fixture',
          promptVersion: 'fixture',
          inputHash: 'fixture',
          sourceId: 'audit-source',
          sourceVersion: 1,
          output: {
            sourceId: 'audit-source',
            items: [
              {
                id: 'audit-item',
                sourceId: 'audit-source',
                sentenceIds: ['audit-s'],
                kind: 'need',
                written: text,
                evidence: 'stated',
                interpretation: {
                  what: '継続申込',
                  shape: 'by',
                  deadline: '2026-12-04T00:00+09:00',
                  deadlineDayOnly: true,
                },
                ...(changeKind ? {} : { conditionNodeId: 'audit-c' }),
                effects: [],
              },
            ],
            unknowns: changeKind
              ? []
              : [
                  {
                    id: 'audit-u',
                    label: '来年度も利用するか',
                    kind: 'family',
                    values: ['yes', 'no'],
                  },
                ],
            conditions: changeKind
              ? []
              : [{ id: 'audit-c', kind: 'eq', unknownId: 'audit-u', value: 'yes' }],
            irrelevantSentenceIds: [],
            ambiguities: [],
          },
        },
      ],
      'system',
      now,
    );
  });
  let n = 0;
  const run = (command: Command) =>
    runCommand(
      store,
      'demo',
      { memberId: 'b', now, operationId: `conditional-${++n}`, demo: true },
      command,
    );
  const before = computePlan(await events(), now);
  expect(
    await run({
      type: 'confirmItem',
      itemId: 'audit-item',
      seen: { throughSeq: before.throughSeq },
    }),
  ).toMatchObject({ status: 'ok' });
  const change: PreviewCommand = {
    type: 'setNeedWays',
    itemId: 'audit-item',
    wayIds: ['way-apply-counter'],
  };
  const shown = previewChange(await events(), { memberId: 'b', now }, change);
  if ('reason' in shown) throw new Error(shown.reason);
  expect(
    await run({ ...change, seen: { throughSeq: shown.throughSeq, changes: shown.seen } }),
  ).toMatchObject({ status: 'ok' });
  const other: PreviewCommand = {
    type: 'stateNeed',
    text: '12月5日12時までに別の申込。',
    interpretation: { what: '別の申込', shape: 'by', deadline: '2026-12-05T12:00+09:00' },
  };
  const otherPreview = previewChange(await events(), { memberId: 'b', now }, other);
  if ('reason' in otherPreview) throw new Error(otherPreview.reason);
  expect(
    await run({
      ...other,
      seen: { throughSeq: otherPreview.throughSeq, changes: otherPreview.seen },
    }),
  ).toMatchObject({ status: 'ok' });
  const otherItemId = computePlan(await events(), now).requirements.find(
    (r) => r.what === '別の申込',
  )?.basis.itemIds[0];
  if (!otherItemId) throw new Error('別の事項が無い');
  const otherWays: PreviewCommand = {
    type: 'setNeedWays',
    itemId: otherItemId,
    wayIds: ['way-apply-online'],
  };
  const waysPreview = previewChange(await events(), { memberId: 'b', now }, otherWays);
  if ('reason' in waysPreview) throw new Error(waysPreview.reason);
  expect(
    await run({
      ...otherWays,
      seen: { throughSeq: waysPreview.throughSeq, changes: waysPreview.seen },
    }),
  ).toMatchObject({ status: 'ok' });
  if (changeKind) {
    // もう一通の読み取りには、未確認の置き換え・取消しがある。製品と同じ変換を通す。
    await store.withHousehold('demo', (log) => {
      const written = '12月6日までに、継続申込の変更を確かめてください。';
      const source = Source.parse({
        id: 'audit-change-source',
        version: 1,
        receivedAt: now,
        sender: 'school',
        language: 'ja',
        medium: 'text',
        sentences: [{ id: 'audit-change-s', text: written }],
      });
      const output = ExtractionOutput.parse({
        items: [
          {
            id: 'i1',
            sentenceIds: ['audit-change-s'],
            kind: 'need',
            written,
            date: null,
            writtenWeekday: 'none',
            startTime: null,
            endTime: null,
            what: '継続申込の変更を確かめる',
            dayType: null,
            deadline: '2026-12-06',
            audience: null,
            place: null,
            relativeDay: 'none',
            conditionNodeId: null,
            inferred: false,
            familyAction: false,
            shape: 'by',
            effects: [{ type: changeKind, itemId: 'audit-item', unknownId: null, value: null }],
          },
        ],
        unknowns: [],
        conditions: [],
        irrelevantSentenceIds: [],
        ambiguities: [],
      });
      const priorItems = currentItems(foldEvents(log.events())).map((entry) => entry.item);
      const { extraction } = toExtraction(output, source, { priorItems, priorUnknowns: [] });
      expect(extraction.items[0]?.effects).toContainEqual({
        type: changeKind,
        itemId: 'audit-item',
      });
      log.append([{ type: 'noticeReceived', source }], 'b', now);
      log.append(
        [
          {
            type: 'modelOutputRecorded',
            call: 'extract',
            model: 'fixture',
            promptVersion: 'fixture',
            inputHash: 'fixture',
            sourceId: source.id,
            sourceVersion: 1,
            output: extraction,
          },
        ],
        'system',
        now,
      );
    });
  }
  const all = await events();
  const plan = computePlan(all, '2026-12-05T09:00+09:00');
  const home = all.findLast((event) => event.type === 'householdSet');
  if (!home) throw new Error('家庭が無い');
  const requirement = plan.requirements.find((r) => r.basis.itemIds.includes('audit-item'));
  const arrangement = plan.arrangements.find((a) => a.requirementKey === requirement?.key);
  expect(requirement?.conditional).toBe(true);
  expect(arrangement?.status).toBe('infeasible');
  expect(arrangement?.options[0]).toMatchObject({
    noSlot: true,
    expired: true,
    deadlineCertainty: 'undetermined',
  });
  const verification = verifyPlan({ household: home.household, plan, events: all });
  expect(verification.issues.filter((i) => i.kind === 'violation')).toEqual([]);
  expect(
    verification.issues.some(
      (i) => i.kind === 'undetermined' && i.code === 'item_condition_unknown',
    ),
  ).toBe(true);
  if (changeKind) {
    expect(
      plan.requirements.some(
        (r) => r.unconfirmed && r.basis.itemIds.includes('audit-change-source:i1'),
      ),
    ).toBe(true);
  }
  const intents = notificationIntents(plan, home.household, notificationHistory(all));
  const otherIntent = intents.find(
    (i) => i.titleKey === 'notify.decide' && i.subject.id !== arrangement?.key,
  );
  expect(otherIntent).toBeDefined();
  const gate = sendGate({
    household: home.household,
    plan,
    events: all,
    batchEnds: all.map((e) => e.seq),
    intents,
  });
  expect(gate.all).toBe(false);
  if (otherIntent) expect(gate.blocked.has(otherIntent.key)).toBe(false);
}

it('未回答の家族条件でも確認済みの締切後に別の通知を止めない', async () => {
  await checkConditional();
});

it.each(['cancel', 'replace'] as const)(
  '元に条件がなくても、未確認の %s を未定のまま残し、別の通知を止めない',
  async (changeKind) => {
    await checkConditional(changeKind);
  },
);
