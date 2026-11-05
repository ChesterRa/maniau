// 架空の二候補について、家族が窓全体を受け持つ手を記録してから占用を足す。
import { type Command, DomainEvent, Household, type SaveablePreview } from '@maniau/core';
import { computePlan, foldEvents } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { notificationPreview } from '../src/notify-preview';
import { previewChange, previewHousehold } from '../src/preview';
import { memoryStore } from '../src/store';

it('候補の窓と、受け持つ人の明示の占用を別々に照らす', async () => {
  const now = '2026-11-25T20:00+09:00';
  const family = Household.parse({
    id: 'fictional',
    region: 'JP',
    timeZone: 'Asia/Tokyo',
    members: [{ id: 'a', kind: 'adult', name: 'アキ' }],
    places: [{ id: 'home', kind: 'home', name: '家' }],
    routines: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      memberId: 'a',
      weekday,
      segments: [{ start: '00:00', end: '23:59', kind: 'home', placeId: 'home' }],
    })),
    careOptions: [],
    ways: [
      {
        id: 'family',
        name: '家族が受け持つ',
        steps: [
          {
            id: 'cover',
            name: '家で見守る',
            durationMin: 10,
            segments: ['home'],
            assigneeId: 'a',
            cover: true,
          },
        ],
        cost: {},
      },
    ],
  });
  const initial = DomainEvent.parse({
    type: 'householdSet',
    household: family,
    id: 'initial',
    householdId: family.id,
    seq: 1,
    version: 1,
    occurredAt: now,
    recordedAt: now,
    actorId: 'a',
  });
  const store = memoryStore(new Map([[family.id, [initial]]]));
  const events = () => store.withHousehold(family.id, (log) => [...log.events()]);
  const plan = async () => computePlan(await events(), now);
  const household = async () => {
    const h = foldEvents(await events()).household;
    if (!h) throw new Error('家が無い');
    return h;
  };
  let count = 0;
  const run = (command: Command) =>
    runCommand(
      store,
      family.id,
      { memberId: 'a', now, demo: true, operationId: `candidate-cover-${++count}` },
      command,
    );
  const save = async (command: SaveablePreview) => {
    const shown = previewChange(await events(), { memberId: 'a', now }, command);
    if ('reason' in shown) throw new Error(shown.reason);
    return run({ ...command, seen: { throughSeq: shown.throughSeq, changes: shown.seen } });
  };
  expect(
    await save({
      type: 'stateNeed',
      text: '12/7か12/8の9時から10時まで見守る',
      interpretation: { what: '見守る', shape: 'window', holdNeeded: false },
      candidates: [
        { date: '2026-12-07', startTime: '09:00', endTime: '10:00' },
        { date: '2026-12-08', startTime: '09:00', endTime: '10:00' },
      ],
    }),
  ).toMatchObject({ status: 'ok' });
  const itemId = (await plan()).requirements.find((r) => r.kind === 'need' && r.live)?.basis
    .itemIds[0];
  if (!itemId) throw new Error('事項が無い');
  expect(await save({ type: 'setNeedWays', itemId, wayIds: ['family'] })).toMatchObject({
    status: 'ok',
  });
  expect(
    await run({
      type: 'setNeedPeople',
      itemId,
      members: ['a'],
      guests: [],
      required: [],
      minCount: 0,
    }),
  ).toMatchObject({ status: 'ok' });
  const before = await events();
  const edited = {
    ...(await household()),
    unavailable: [{ id: 'u1', memberId: 'a', date: '2026-12-08', start: '09:15', end: '09:30' }],
  };
  const preview = previewHousehold(before, { memberId: 'a', now }, edited);
  if ('reason' in preview) throw new Error(preview.reason);
  expect(
    await run({
      type: 'updateHousehold',
      household: edited,
      seen: { throughSeq: preview.throughSeq, changes: preview.seen },
    }),
  ).toMatchObject({ status: 'ok' });
  const p = await plan();
  const log = await events();
  const h = await household();
  const when = p.requirements.find((r) => r.basis.itemIds.includes(itemId))?.when;
  const first = when?.candidates.find((c) => c.id === 'c1');
  const second = when?.candidates.find((c) => c.id === 'c2');
  if (!first || !second) throw new Error('候補が無い');
  expect(first.ways[0]?.usable).toBe(true);
  expect(second.ways[0]?.usable).toBe(true);
  expect(second.ways[0]?.reasons).not.toContain('coverGaps');
  const report = verifyPlan({ household: h, plan: p, events: log });
  expect(report.issues.filter((i) => i.kind === 'violation')).toEqual([]);
  expect(notificationPreview(log, p, h).blockedAll).toBe(false);
});
