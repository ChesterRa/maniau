// 育児の外の架空の例。家庭・資源・登録・やり方は試験で用意する。
// 12/12 の集まりの会場を準備するが、抽選への申込は当選・会場の確保ではない。
// 月ごとの申込期間は現在の締切の型に無いため、架空の 11/28 18:00 までを言明する。
// Claude の読み取り、他領域の実利用、参加者・投票・集計は確かめていない。
import {
  type Command,
  DomainEvent,
  Household,
  proposalSnapshot,
  type SaveablePreview,
} from '@maniau/core';
import { computePlan, foldEvents } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { previewChange } from '../src/preview';
import { memoryStore } from '../src/store';

const NOW = '2026-11-25T20:00+09:00';
const COST = { leaveMinutes: 0, helperRequests: 0, yen: 0, extraTasks: 0 };

/** 全て架空。住所、施設の実際の制度や参加者の回答は与えない。 */
function initialHousehold() {
  return Household.parse({
    id: 'gathering-home',
    region: 'JP',
    timeZone: 'Asia/Tokyo',
    members: [
      { id: 'a', kind: 'adult', name: 'アキ' },
      { id: 'b', kind: 'adult', name: 'ボウ' },
      { id: 'helper', kind: 'helper', name: '協力先' },
    ],
    places: [{ id: 'home', kind: 'home', name: '家' }],
    routines: ['a', 'b'].flatMap((memberId) =>
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        memberId,
        weekday,
        segments: [{ start: '00:00', end: '23:59', kind: 'home', placeId: 'home' }],
      })),
    ),
    careOptions: [],
    resources: [
      { id: 'res-venue', kind: 'place', name: '架空の練習施設', notes: [], use: 'candidate' },
    ],
    preparations: [
      {
        id: 'prep-group',
        name: '架空の施設の団体登録',
        resourceId: 'res-venue',
        appliesTo: { kind: 'household' },
        state: 'unknown',
      },
    ],
    ways: [
      {
        id: 'way-lottery',
        name: '抽選に申し込む',
        deadline: { type: 'onTheDay', at: '17:00' },
        steps: [
          {
            id: 'apply',
            name: '抽選に申し込む',
            durationMin: 10,
            segments: ['home'],
            waitAfterMin: 0,
            assigneeId: 'a',
          },
        ],
        cost: COST,
        requires: ['prep-group'],
        resourceIds: ['res-venue'],
      },
      {
        id: 'way-open',
        name: '空き枠に申し込む',
        deadline: { type: 'onTheDay', at: '17:30' },
        steps: [
          {
            id: 'apply',
            name: '空き枠に申し込む',
            durationMin: 5,
            segments: ['home'],
            waitAfterMin: 0,
            assigneeId: 'a',
          },
        ],
        cost: { ...COST, yen: 100 },
        resourceIds: ['res-venue'],
      },
      {
        id: 'way-ask',
        name: '協力先に尋ねる',
        deadline: { type: 'daysBefore', days: 1, at: '18:00' },
        steps: [
          {
            id: 'ask',
            name: '協力先に施設の受付を尋ねる',
            durationMin: 5,
            segments: ['home'],
            external: { to: 'helper', kind: 'reply' },
            waitAfterMin: 0,
            assigneeId: 'a',
          },
        ],
        cost: { ...COST, helperRequests: 1 },
      },
    ],
  });
}

it('架空の集まりの会場の申込を、前提から頼み・返事待ち・変更まで確かめる', async () => {
  const household = initialHousehold();
  const householdSet = DomainEvent.parse({
    type: 'householdSet',
    household,
    id: 'initial',
    householdId: household.id,
    seq: 1,
    version: 1,
    occurredAt: NOW,
    recordedAt: NOW,
    actorId: 'a',
  });
  const store = memoryStore(new Map([[household.id, [householdSet]]]));
  const events = () => store.withHousehold(household.id, (log) => [...log.events()]);
  let sequence = 0;
  const run = (command: Command) =>
    runCommand(
      store,
      household.id,
      { memberId: 'a', now: NOW, operationId: `gathering-${++sequence}`, demo: true },
      command,
    );
  const preview = async (command: SaveablePreview) =>
    previewChange(await events(), { memberId: 'a', now: NOW }, command);
  const save = async (command: SaveablePreview) => {
    const shown = await preview(command);
    if ('reason' in shown) throw new Error(shown.reason);
    return run({ ...command, seen: { throughSeq: shown.throughSeq, changes: shown.seen } });
  };
  const plan = async () => computePlan(await events(), NOW);
  const arrangement = async () => {
    const found = (await plan()).arrangements.find((a) => a.kind === 'need' && a.live);
    if (!found) throw new Error('「すること」の手配が無い');
    return found;
  };

  expect(
    await save({
      type: 'stateNeed',
      text: '12月12日午前の練習に向け、架空の施設へ11月28日18時までに申し込む。',
      interpretation: {
        what: '12月12日午前の練習のために架空の施設へ申し込む',
        shape: 'by',
        deadline: '2026-11-28T18:00+09:00',
      },
    }),
  ).toMatchObject({ status: 'ok' });
  const itemId = (await plan()).requirements.find((r) => r.kind === 'need' && r.live)?.basis
    .itemIds[0];
  if (!itemId) throw new Error('「すること」の事項が無い');
  expect(
    await save({
      type: 'setNeedWays',
      itemId,
      wayIds: ['way-lottery', 'way-open', 'way-ask'],
    }),
  ).toMatchObject({ status: 'ok' });

  let current = await arrangement();
  const lottery = current.options.find((option) => option.templateId === 'way-lottery');
  const open = current.options.find((option) => option.templateId === 'way-open');
  let ask = current.options.find((option) => option.templateId === 'way-ask');
  if (!lottery || !open || !ask) throw new Error('申込の手が無い');
  expect(lottery.needsPreparation).toEqual([{ preparationId: 'prep-group', state: 'unknown' }]);
  expect(current.recommendedOptionKey).toBeUndefined();
  // それぞれ架空の締切から、申込にかかる分を引く。
  expect(lottery.decisionDeadline).toBe('2026-11-28T16:50+09:00');
  expect(open.decisionDeadline).toBe('2026-11-28T17:25+09:00');
  expect(ask.decisionDeadline).toBe('2026-11-27T17:55+09:00');
  expect(current.options.every((option) => option.coverGaps === undefined)).toBe(true);

  const beforeEdit = foldEvents(await events()).household;
  if (!beforeEdit) throw new Error('家の情報が無い');
  const afterEdit = {
    ...beforeEdit,
    preparations: beforeEdit.preparations.map((p) =>
      p.id === 'prep-group' ? { ...p, state: 'done' as const } : p,
    ),
  };
  const edit = await preview({ type: 'updateHousehold', household: afterEdit });
  if ('reason' in edit) throw new Error(edit.reason);
  expect(edit.changes.preparations.some((c) => c.before.length === 1 && c.after.length === 0)).toBe(
    true,
  );
  expect(
    await run({
      type: 'updateHousehold',
      household: afterEdit,
      seen: { throughSeq: edit.throughSeq, changes: edit.seen },
    }),
  ).toMatchObject({ status: 'ok' });

  current = await arrangement();
  ask = current.options.find((option) => option.templateId === 'way-ask');
  if (!ask) throw new Error('協力先に尋ねる手が無い');
  expect(
    current.options.find((o) => o.templateId === 'way-lottery')?.needsPreparation,
  ).toBeUndefined();
  expect(
    await run({
      type: 'chooseOption',
      arrangementKey: current.key,
      optionKey: ask.key,
      role: 'primary',
      assigneeId: 'a',
    }),
  ).toMatchObject({ status: 'ok' });

  let computed = await plan();
  const task = computed.tasks.find((t) => t.basis.optionKey === ask?.key && t.external);
  const shown = task && proposalSnapshot(task);
  if (!task || !shown) throw new Error('尋ねる作業が無い');
  expect(task).toMatchObject({
    assigneeId: 'a',
    commitment: 'proposed',
    external: { to: 'helper', kind: 'reply' },
  });
  expect(await run({ type: 'accept', taskKey: task.key, shown })).toMatchObject({ status: 'ok' });
  expect(
    await run({ type: 'recordSent', taskKey: task.key, requestId: 'req-gathering' }),
  ).toMatchObject({ status: 'ok' });
  computed = await plan();
  expect(computed.requests.find((r) => r.requestId === 'req-gathering')?.state).toBe(
    'awaitingReply',
  );

  const beforeWhatIf = await events();
  const whatIf = previewChange(
    beforeWhatIf,
    { memberId: 'a', now: NOW },
    {
      type: 'recordReply',
      requestId: 'req-gathering',
      reply: 'no',
    },
  );
  if ('reason' in whatIf) throw new Error(whatIf.reason);
  expect(whatIf.arrangement?.reasons).toContainEqual({
    code: 'turnedDown',
    refs: ['req-gathering'],
  });
  expect(whatIf.changes.recommendations).toContainEqual(
    expect.objectContaining({
      kind: 'need',
      after: expect.objectContaining({ templateId: 'way-lottery' }),
    }),
  );
  expect(await events()).toEqual(beforeWhatIf);
  expect((await plan()).requests.find((r) => r.requestId === 'req-gathering')?.state).toBe(
    'awaitingReply',
  );

  const dismiss = await preview({ type: 'dismissItem', itemId, reason: 'other' });
  if ('reason' in dismiss) throw new Error(dismiss.reason);
  expect(dismiss.changes.cancels.map((r) => r.requestId)).toEqual(['req-gathering']);
  const recorded = await events();
  const currentHousehold = foldEvents(recorded).household;
  if (!currentHousehold) throw new Error('家の情報が無い');
  const verification = verifyPlan({
    household: currentHousehold,
    plan: await plan(),
    events: recorded,
  });
  expect(verification.status).toBe('undetermined');
  expect(verification.issues.filter((issue) => issue.kind === 'violation')).toEqual([]);
  expect(verification.issues).toContainEqual(
    expect.objectContaining({ kind: 'undetermined', code: 'requirement_coverage_unverified' }),
  );
});
