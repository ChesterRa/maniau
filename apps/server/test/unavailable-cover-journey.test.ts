// 架空の家で、窓を家族が受け持つ手と、明示の占用を正式な命令で照らす。
import { type Command, DomainEvent, Household, type SaveablePreview } from '@maniau/core';
import { computePlan, foldEvents } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { notificationPreview } from '../src/notify-preview';
import { previewChange, previewHousehold } from '../src/preview';
import { memoryStore } from '../src/store';

it('家族の受け持ちの窓に占用がある時、その手の不足を残し、ほかの手は塞がない', async () => {
  const now = '2026-11-25T20:00+09:00';
  const family = Household.parse({
    id: 'fictional',
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
      {
        id: 'external',
        name: '協力先に頼む',
        steps: [
          {
            id: 'ask',
            name: '協力先に尋ねる',
            durationMin: 5,
            segments: ['home'],
            assigneeId: 'a',
            cover: true,
            external: { to: 'helper', kind: 'reply' },
          },
        ],
        cost: { helperRequests: 1 },
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
      { memberId: 'a', now, demo: true, operationId: `cover-busy-${++count}` },
      command,
    );
  const save = async (command: SaveablePreview) => {
    const shown = previewChange(await events(), { memberId: 'a', now }, command);
    if ('reason' in shown) throw new Error(shown.reason);
    return run({ ...command, seen: { throughSeq: shown.throughSeq, changes: shown.seen } });
  };
  const verify = async () => {
    const log = await events();
    const p = await plan();
    const h = await household();
    expect(
      verifyPlan({ household: h, plan: p, events: log }).issues.filter(
        (i) => i.kind === 'violation',
      ),
    ).toEqual([]);
    expect(notificationPreview(log, p, h).blockedAll).toBe(false);
    return { log, p, h };
  };
  expect(
    await save({
      type: 'stateNeed',
      text: '12/7の9時から10時まで子を見守る',
      interpretation: {
        what: '子を見守る',
        shape: 'window',
        date: '2026-12-07',
        startTime: '09:00',
        endTime: '10:00',
      },
    }),
  ).toMatchObject({ status: 'ok' });
  const itemId = (await plan()).requirements.find((r) => r.kind === 'need' && r.live)?.basis
    .itemIds[0];
  if (!itemId) throw new Error('事項が無い');
  expect(await save({ type: 'setNeedWays', itemId, wayIds: ['family', 'external'] })).toMatchObject(
    { status: 'ok' },
  );
  const initialPlan = await verify();
  const arrangement = initialPlan.p.arrangements.find((a) => a.kind === 'need' && a.live);
  const option = arrangement?.options.find((o) => o.templateId === 'family');
  if (!arrangement || !option) throw new Error('手が無い');
  expect(option.coverGaps).toBeUndefined();
  const edited = {
    ...initialPlan.h,
    unavailable: [{ id: 'u1', memberId: 'a', date: '2026-12-07', start: '09:15', end: '09:30' }],
  };
  const shown = previewHousehold(initialPlan.log, { memberId: 'a', now }, edited);
  if ('reason' in shown) throw new Error(shown.reason);
  expect(
    await run({
      type: 'updateHousehold',
      household: edited,
      seen: { throughSeq: shown.throughSeq, changes: shown.seen },
    }),
  ).toMatchObject({ status: 'ok' });
  const current = await verify();
  const later = current.p.arrangements.find((a) => a.key === arrangement.key);
  const blocked = later?.options.find((o) => o.templateId === 'family');
  const other = later?.options.find((o) => o.templateId === 'external');
  expect(blocked?.coverGaps).toEqual([
    { start: '2026-12-07T09:00+09:00', end: '2026-12-07T10:00+09:00' },
  ]);
  expect(other?.coverGaps).toBeUndefined();
  expect(later?.recommendedOptionKey).not.toBe(blocked?.key);
  const fake = structuredClone(current.p);
  const fakeOption = fake.arrangements
    .find((a) => a.key === arrangement.key)
    ?.options.find((o) => o.templateId === 'family');
  if (!fakeOption) throw new Error('案が無い');
  delete fakeOption.coverGaps;
  expect(
    verifyPlan({ household: current.h, plan: fake, events: current.log }).issues,
  ).toContainEqual(
    expect.objectContaining({ kind: 'violation', code: 'need_potential_gap_mismatch' }),
  );
  if (!blocked) throw new Error('家族の手が無い');
  expect(
    await run({
      type: 'chooseOption',
      arrangementKey: arrangement.key,
      optionKey: blocked.key,
      role: 'primary',
      assigneeId: 'a',
    }),
  ).toMatchObject({ status: 'ok' });
  const chosen = await verify();
  expect(chosen.p.arrangements.find((a) => a.key === arrangement.key)?.reasons).toContainEqual({
    code: 'notCovered',
    refs: ['2026-12-07T09:00+09:00/2026-12-07T10:00+09:00'],
  });
  const { unavailable: _removed, ...restored } = chosen.h;
  const removing = previewHousehold(chosen.log, { memberId: 'a', now }, restored);
  if ('reason' in removing) throw new Error(removing.reason);
  expect(
    await run({
      type: 'updateHousehold',
      household: restored,
      seen: { throughSeq: removing.throughSeq, changes: removing.seen },
    }),
  ).toMatchObject({ status: 'ok' });
  const after = await verify();
  expect(
    after.p.arrangements
      .find((a) => a.key === arrangement.key)
      ?.options.find((o) => o.templateId === 'family')?.coverGaps,
  ).toBeUndefined();
});
