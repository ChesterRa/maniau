// やり方の直しで足した手伝いの人は、Postgres の成員の表（権限の正本）にも同じトランザクションで入る：家族の情報の
// 事象と成員の表の顔ぶれを揃える。手伝いの人はログインしない（身元を持たず、大人ではない）。移行を当てた PGlite。
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { members } from '../src/db/schema';
import { demoEvents } from '../src/demo';
import { previewHousehold } from '../src/preview';
import { database, H, seeded } from './pg';

const NOW = '2026-11-25T20:00+09:00';

describe('やり方の直しで足した手伝いの人（Postgres）', () => {
  it('家族の情報の事象と同じトランザクションで成員の表に入り、身元を持たない', async () => {
    const db = await database();
    const store = await seeded(db, H, demoEvents('arrived'));
    const events = await store.withHousehold(H, (log) => [...log.events()]);
    const set = events.flatMap((e) => (e.type === 'householdSet' ? [e.household] : [])).at(-1);
    if (!set) throw new Error('家族の情報が無い');
    const edited = structuredClone(set);
    edited.members.push({ id: 'yamada', kind: 'helper', name: '山田さん', active: true });
    edited.ways.push({
      id: 'way-neighbor',
      name: '近所の山田さんに来てもらう',
      steps: [
        {
          id: 'ask',
          name: '山田さんに来てもらえるか聞く',
          durationMin: 5,
          segments: ['home', 'commute', 'work'],
          external: { to: 'yamada', kind: 'reply' },
          waitAfterMin: 0,
          cover: true,
        },
      ],
      cost: { leaveMinutes: 0, helperRequests: 1, yen: 0, extraTasks: 0, unknown: ['yen'] },
    });
    const shown = previewHousehold(events, { memberId: 'b', now: NOW }, edited);
    if ('reason' in shown) throw new Error(shown.reason);
    const result = await runCommand(
      store,
      H,
      { memberId: 'b', operationId: 'ways-db-1', now: NOW, demo: false },
      {
        type: 'updateHousehold',
        household: edited,
        seen: { throughSeq: shown.throughSeq, changes: shown.seen },
      },
    );
    expect(result).toMatchObject({ status: 'ok' });
    const rows = await db
      .select()
      .from(members)
      .where(and(eq(members.householdId, H), eq(members.id, 'yamada')));
    expect(rows).toEqual([
      { householdId: H, id: 'yamada', kind: 'helper', active: true, identityId: null },
    ]);
    const after = await store.withHousehold(H, (log) => [...log.events()]);
    const saved = after.flatMap((e) => (e.type === 'householdSet' ? [e.household] : [])).at(-1);
    expect(saved?.members.map((m) => m.id)).toContain('yamada');
    // 同じ操作を送り直しても、何も足さない（成員の行を二つにしない）。
    expect(
      await runCommand(
        store,
        H,
        { memberId: 'b', operationId: 'ways-db-1', now: NOW, demo: false },
        {
          type: 'updateHousehold',
          household: edited,
          seen: { throughSeq: shown.throughSeq, changes: shown.seen },
        },
      ),
    ).toMatchObject({ status: 'noop' });
    expect(
      await db
        .select()
        .from(members)
        .where(and(eq(members.householdId, H), eq(members.id, 'yamada'))),
    ).toHaveLength(1);
  });
});
