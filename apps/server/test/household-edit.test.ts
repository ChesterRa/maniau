// 家と暮らしの情報を直す（updateHousehold）：書き込まずに「この変更で変わること」を見て、見た物と今の同じ計算が
// 同じ時だけ書く。直せる範囲はエンジンが正しく扱える物に限る（成員の身元・場所・取れる手の形は替えない、
// 日をまたぐ営業時間と、家にいる区間の無い大人の一日は受けない）。見るだけでは何も書かない。
import { type Household, toEpochMinutes } from '@maniau/core';
import { computePlan, foldEvents } from '@maniau/core/engine';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { previewHousehold } from '../src/preview';
import { memoryStore } from '../src/store';

const NOW = '2026-11-25T20:00+09:00';

async function setup() {
  const store = memoryStore(new Map([['demo', demoEvents('arrived')]]));
  const events = () => store.withHousehold('demo', (log) => [...log.events()]);
  const household = async (): Promise<Household> => {
    const current = foldEvents(await events()).household;
    if (!current) throw new Error('家族の情報が無い');
    return structuredClone(current);
  };
  let sequence = 0;
  const run = (command: Parameters<typeof runCommand>[3], now = NOW, memberId = 'b') =>
    runCommand(
      store,
      'demo',
      { memberId, now, operationId: `household-${++sequence}`, demo: true },
      command,
    );
  const preview = async (edited: Household, now = NOW) =>
    previewHousehold(await events(), { memberId: 'b', now }, edited);
  return { store, events, household, run, preview };
}

/** 祖母に頼む手の締切を、3日前から5日前にする。 */
const earlierGrandma = (h: Household): Household => ({
  ...h,
  careOptions: h.careOptions.map((o) =>
    o.id === 'opt-grandma' && o.deadline.type === 'daysBefore'
      ? { ...o, deadline: { ...o.deadline, days: 5 } }
      : o,
  ),
});

describe('家と暮らしの情報を直す', () => {
  it('書き込まずに「この変更で変わること」（手の決め時）を見せ、見ても何も書かない', async () => {
    const app = await setup();
    const before = (await app.events()).length;
    const shown = await app.preview(earlierGrandma(await app.household()));
    if ('reason' in shown) throw new Error(shown.reason);
    const grandma = shown.changes.deadlines.find((d) => d.optionKey.endsWith('opt-grandma'));
    const was = grandma?.before?.decisionDeadline;
    const will = grandma?.after?.decisionDeadline;
    if (!was || !will) throw new Error('祖母の手の決め時が無い');
    // 締切の決まりが2日早くなった分だけ、決め時も早くなる（ほかの手は替わらない）。
    expect(toEpochMinutes(was) - toEpochMinutes(will)).toBe(2 * 24 * 60);
    expect(shown.changes.deadlines).toHaveLength(1);
    expect(shown.issues).toEqual([]);
    expect(shown.seen).toMatch(/^[0-9a-f]{32}$/);
    expect((await app.events()).length).toBe(before);
  });

  it('見た計画の番号と見た物の要約が今と同じ時だけ書き、計画が変わる', async () => {
    const app = await setup();
    const edited = earlierGrandma(await app.household());
    const shown = await app.preview(edited);
    if ('reason' in shown) throw new Error(shown.reason);
    const { throughSeq } = computePlan(await app.events(), NOW);
    expect(
      await app.run({
        type: 'updateHousehold',
        household: edited,
        seen: { throughSeq, changes: shown.seen },
      }),
    ).toMatchObject({ status: 'ok' });
    const grandmaDeadline = (events: Awaited<ReturnType<typeof app.events>>) =>
      computePlan(events, NOW)
        .arrangements.flatMap((a) => a.options)
        .find((o) => o.key.endsWith('opt-grandma'))?.decisionDeadline;
    expect(grandmaDeadline(await app.events())).toBe(
      shown.changes.deadlines[0]?.after?.decisionDeadline,
    );
  });

  it('要約が無い・番号が古い・要約が違う（別の直しの物）・時が進んで結果が変わった直しを書かない', async () => {
    const app = await setup();
    const edited = earlierGrandma(await app.household());
    const shown = await app.preview(edited);
    if ('reason' in shown) throw new Error(shown.reason);
    const { throughSeq } = computePlan(await app.events(), NOW);
    const count = (await app.events()).length;
    expect(await app.run({ type: 'updateHousehold', household: edited })).toMatchObject({
      status: 'invalid',
      reason: 'seenRequired',
    });
    expect(
      await app.run({
        type: 'updateHousehold',
        household: edited,
        seen: { throughSeq: throughSeq - 1, changes: shown.seen },
      }),
    ).toMatchObject({ status: 'conflict', reason: 'proposalChanged' });
    // 見た物と違う直し（名前だけ替えた）を、前の要約で書こうとしても断る。
    const other = {
      ...edited,
      members: edited.members.map((m) => (m.id === 'g' ? { ...m, name: '祖母' } : m)),
    };
    expect(
      await app.run({
        type: 'updateHousehold',
        household: other,
        seen: { throughSeq, changes: shown.seen },
      }),
    ).toMatchObject({ status: 'conflict', reason: 'consequencesChanged' });
    // 事象は増えないまま、新しい締切（12/2 21:00）を過ぎた。見た時と結果が違うので書かない。
    expect(
      await app.run(
        { type: 'updateHousehold', household: edited, seen: { throughSeq, changes: shown.seen } },
        '2026-12-03T09:00+09:00',
      ),
    ).toMatchObject({ status: 'conflict', reason: 'consequencesChanged' });
    expect((await app.events()).length).toBe(count);
  });

  it('成員の種類・有効・削除と大人・子の追加、場所の削除と種類、取れる手の形、家庭の ID は替えられない', async () => {
    const app = await setup();
    const h = await app.household();
    const refused = async (edited: Household, reason: string) => {
      const shown = await app.preview(edited);
      expect(shown).toMatchObject({ status: 'invalid', reason });
    };
    await refused(
      { ...h, members: h.members.map((m) => (m.id === 'g' ? { ...m, kind: 'adult' } : m)) },
      'membersLocked',
    );
    await refused(
      { ...h, members: h.members.map((m) => (m.id === 'a' ? { ...m, active: false } : m)) },
      'membersLocked',
    );
    // 取れる手が頼む相手として使っている人を消すと、家の情報として成り立たない（その前に断る）。
    await refused({ ...h, members: h.members.filter((m) => m.id !== 'g') }, 'householdInvalid');
    // 大人・子は足せない（足せるのは手伝いの人だけ。ways-edit.test.ts）。
    await refused(
      {
        ...h,
        members: [...h.members, { id: 'n', kind: 'child', name: '架空の子', active: true }],
      },
      'membersLocked',
    );
    await refused(
      { ...h, places: h.places.filter((p) => p.id !== 'store-super-toyosu') },
      'placesLocked',
    );
    await refused(
      { ...h, places: h.places.map((p) => (p.id === 'gakudo' ? { ...p, kind: 'other' } : p)) },
      'placesLocked',
    );
    await refused(
      {
        ...h,
        careOptions: h.careOptions.map((o) =>
          o.id === 'opt-grandma' ? { ...o, cancellable: !o.cancellable } : o,
        ),
      },
      'careOptionsLocked',
    );
    await refused({ ...h, id: 'other-household' }, 'householdIdentity');
  });

  it('日をまたぐ営業時間は受けない', async () => {
    const app = await setup();
    const h = await app.household();
    const overnight: Household = {
      ...h,
      places: h.places.map((p) =>
        p.id === 'store-super-toyosu' && p.hours
          ? {
              ...p,
              hours: { ...p.hours, periods: [{ weekday: 1, open: '19:00', close: '09:00' }] },
            }
          : p,
      ),
    };
    expect(await app.preview(overnight)).toMatchObject({
      status: 'invalid',
      reason: 'hoursOvernight',
    });
  });

  it('家にいるのが朝だけの日も、一日中出かけている日も、子の居場所の手配は無くならない（その時間に広がる）', async () => {
    const app = await setup();
    const h = await app.household();
    const care = 'arr:childCare:n1:i6:c';
    const window = async () => {
      const found = computePlan(await app.events(), NOW).arrangements.find((a) => a.key === care);
      return found?.live ? [found.start, found.end] : undefined;
    };
    expect(await window()).toEqual(['2026-12-07T08:10+09:00', '2026-12-07T18:15+09:00']);
    const monday = (segments: Household['routines'][number]['segments']): Household => ({
      ...h,
      routines: h.routines.map((day) =>
        day.weekday === 1 && (day.memberId === 'a' || day.memberId === 'b')
          ? { ...day, segments }
          : day,
      ),
    });
    const save = async (edited: Household) => {
      const shown = await app.preview(edited);
      if ('reason' in shown) throw new Error(shown.reason);
      const { throughSeq } = computePlan(await app.events(), NOW);
      expect(
        await app.run({
          type: 'updateHousehold',
          household: edited,
          seen: { throughSeq, changes: shown.seen },
        }),
      ).toMatchObject({ status: 'ok' });
    };
    // 二人とも 7:00 に家を出て、そのまま一日の終わりまで帰らない。
    await save(
      monday([
        { start: '00:00', end: '07:00', kind: 'home', placeId: 'home', viaStationIds: [] },
        { start: '07:00', end: '23:59', kind: 'away', viaStationIds: [] },
      ]),
    );
    expect(await window()).toEqual(['2026-12-07T07:00+09:00', '2026-12-07T23:59+09:00']);
    // 二人とも一日中出かけている（家にいる区間が無い）。
    await save(monday([{ start: '00:00', end: '23:59', kind: 'away', viaStationIds: [] }]));
    expect(await window()).toEqual(['2026-12-07T00:00+09:00', '2026-12-07T23:59+09:00']);
  });

  it('直した営業時間は家族が確かめた物にし、名前だけの直しでは調べた所を替えない', async () => {
    const app = await setup();
    const h = await app.household();
    const store = h.places.find((p) => p.id === 'store-clothing-toyosu');
    if (!store?.hours) throw new Error('店の営業時間が無い');
    const renamed: Household = {
      ...h,
      places: h.places.map((p) => (p.id === store.id ? { ...p, name: '駅前の衣料品店' } : p)),
    };
    const write = async (edited: Household) => {
      const shown = await app.preview(edited);
      if ('reason' in shown) throw new Error(shown.reason);
      const { throughSeq } = computePlan(await app.events(), NOW);
      return app.run({
        type: 'updateHousehold',
        household: edited,
        seen: { throughSeq, changes: shown.seen },
      });
    };
    expect(await write(renamed)).toMatchObject({ status: 'ok' });
    const afterRename = foldEvents(await app.events()).household?.places.find(
      (p) => p.id === store.id,
    );
    expect(afterRename?.hours?.source).toBe(store.hours.source);
    const shorter = structuredClone(renamed);
    const target = shorter.places.find((p) => p.id === store.id);
    if (!target?.hours) throw new Error('店の営業時間が無い');
    target.hours.periods = target.hours.periods.map((p) => ({ ...p, close: '19:00' }));
    expect(await write(shorter)).toMatchObject({ status: 'ok' });
    const afterHours = foldEvents(await app.events()).household?.places.find(
      (p) => p.id === store.id,
    );
    expect(afterHours?.hours).toMatchObject({ source: 'family', checkedAt: NOW });
  });

  it('大人でない人は直せない', async () => {
    const app = await setup();
    const edited = earlierGrandma(await app.household());
    expect(
      await app.run(
        { type: 'updateHousehold', household: edited, seen: { throughSeq: 0, changes: 'x' } },
        NOW,
        'g',
      ),
    ).toMatchObject({ status: 'forbidden' });
  });

  it('同じ条件の店がもう一軒あり、前の店をその日休みにして、同じ時刻・同じ人のまま店が替われば「変わること」に出す', async () => {
    const now = '2026-11-26T12:10+09:00';
    const store = memoryStore(new Map([['demo', demoEvents('asked')]]));
    const events = () => store.withHousehold('demo', (log) => [...log.events()]);
    const run = (command: Parameters<typeof runCommand>[3], id: string) =>
      runCommand(store, 'demo', { memberId: 'b', now, operationId: id, demo: true }, command);
    // 位置・営業時間・駅からの歩きが同じ衣料品店を、もう一軒足して保存する。
    const current = foldEvents(await events()).household;
    const first = current?.places.find((p) => p.id === 'store-clothing-toyosu');
    if (!current || !first) throw new Error('衣料品店が無い');
    const twin = {
      ...structuredClone(first),
      id: 'store-clothing-toyosu-2',
      name: '二軒目の衣料品店',
    };
    const withTwin = { ...structuredClone(current), places: [...current.places, twin] };
    const added = previewHousehold(await events(), { memberId: 'b', now }, withTwin);
    if ('reason' in added) throw new Error(added.reason);
    expect(
      await run(
        {
          type: 'updateHousehold',
          household: withTwin,
          seen: { throughSeq: added.throughSeq, changes: added.seen },
        },
        'twin',
      ),
    ).toMatchObject({ status: 'ok' });
    const buy = computePlan(await events(), now).tasks.find(
      (t) => t.live && t.atPlaceId === first.id,
    );
    if (!buy?.start) throw new Error('一軒目で買う作業が無い');
    // 一軒目を、買う日だけ休みにする。
    const saved = foldEvents(await events()).household;
    if (!saved) throw new Error('家族の情報が無い');
    const closed = structuredClone(saved);
    const place = closed.places.find((p) => p.id === first.id);
    if (!place?.hours) throw new Error('店の営業時間が無い');
    place.hours.closedDates = [...place.hours.closedDates, buy.start.slice(0, 10)];
    const shown = previewHousehold(await events(), { memberId: 'b', now }, closed);
    if ('reason' in shown) throw new Error(shown.reason);
    expect(shown.changes.relocated).toEqual([
      { taskKey: buy.key, before: first.id, after: twin.id },
    ]);
    expect(shown.changes.moved).toEqual([]);
    expect(shown.changes.reassigned).toEqual([]);
  });

  it('買える時が無くなる営業時間にすると、決め時を計算できない手として渡す（もう間に合わないとは言わない）', async () => {
    const now = '2026-11-26T12:10+09:00';
    const events = demoEvents('asked');
    const current = foldEvents(events).household;
    if (!current) throw new Error('家族の情報が無い');
    const buy = computePlan(events, now).arrangements.find((a) => a.live && a.kind === 'purchase');
    if (!buy) throw new Error('買い物の手配が無い');
    // 衣料品店を、毎日 09:00–09:01 だけ開く形にする（同じ日の中の区間なので、直しとしては受ける）。
    const shortHours = structuredClone(current);
    for (const place of shortHours.places) {
      if (place.id === 'store-clothing-toyosu' && place.hours) {
        place.hours.periods = place.hours.periods.map((p) => ({
          ...p,
          open: '09:00',
          close: '09:01',
        }));
      }
    }
    const shown = previewHousehold(events, { memberId: 'b', now }, shortHours);
    if ('reason' in shown) throw new Error(shown.reason);
    const change = shown.changes.deadlines.find((d) => d.arrangementKey === buy.key);
    expect(change?.after).toEqual({ deadlineCertainty: 'undetermined', expired: true });
    expect(change?.before?.deadlineCertainty).not.toBe('undetermined');
  });

  it('家を出る時刻を早めると、子の居場所の手配が要る時間の変化を見せる', async () => {
    const app = await setup();
    const h = await app.household();
    // 健太（a）の月曜：家の区間の終わりと、続く通勤の始まりを 08:10 から 08:00 にする（区間は切れ目なく続く）。
    const earlier: Household = {
      ...h,
      routines: h.routines.map((day) =>
        day.weekday === 1 && day.memberId === 'a'
          ? {
              ...day,
              segments: day.segments.map((s) =>
                s.end === '08:10'
                  ? { ...s, end: '08:00' }
                  : s.start === '08:10'
                    ? { ...s, start: '08:00' }
                    : s,
              ),
            }
          : day,
      ),
    };
    const shown = await app.preview(earlier);
    if ('reason' in shown) throw new Error(shown.reason);
    expect(shown.changes.windows).toEqual([
      expect.objectContaining({
        arrangementKey: 'arr:childCare:n1:i6:c',
        before: { start: '2026-12-07T08:10+09:00', end: '2026-12-07T18:15+09:00' },
        after: { start: '2026-12-07T08:00+09:00', end: '2026-12-07T18:15+09:00' },
      }),
    ]);
  });

  it('区間の間に書かれていない時間を作る直しと、大人の曜日を消す直しは受けない', async () => {
    const app = await setup();
    const h = await app.household();
    // 健太（a）の月曜：帰りの通勤は 18:15 に家に着くまま、家の区間だけを 19:00 からにする（18:15–19:00 が空く）。
    const gap: Household = {
      ...h,
      routines: h.routines.map((day) =>
        day.weekday === 1 && day.memberId === 'a'
          ? {
              ...day,
              segments: day.segments.map((s) =>
                s.kind === 'home' && s.start === '18:15' ? { ...s, start: '19:00' } : s,
              ),
            }
          : day,
      ),
    };
    expect(await app.preview(gap)).toMatchObject({ status: 'invalid', reason: 'routineGap' });
    const dropped: Household = {
      ...h,
      routines: h.routines.filter((day) => !(day.weekday === 1 && day.memberId === 'a')),
    };
    expect(await app.preview(dropped)).toMatchObject({
      status: 'invalid',
      reason: 'routineDayMissing',
    });
    // 過ごし方と場所の食い違い（家の場所での外出）も受けない。
    const outAtHome: Household = {
      ...h,
      routines: h.routines.map((day) =>
        day.weekday === 1 && day.memberId === 'a'
          ? {
              ...day,
              segments: day.segments.map((s, i) => (i === 0 ? { ...s, kind: 'away' as const } : s)),
            }
          : day,
      ),
    };
    expect(await app.preview(outAtHome)).toMatchObject({
      status: 'invalid',
      reason: 'routinePlace',
    });
  });

  it('頼んで「はい」をもらった後に帰る時刻を遅らせると、手配の要る時間が延び、頼んだ相手に確かめが要ると見せる', async () => {
    const now = '2026-11-29T21:00+09:00';
    const store = memoryStore(new Map([['demo', demoEvents('chase')]]));
    const events = () => store.withHousehold('demo', (log) => [...log.events()]);
    let sequence = 0;
    const run = (command: Parameters<typeof runCommand>[3]) =>
      runCommand(
        store,
        'demo',
        { memberId: 'b', now, operationId: `chase-${++sequence}`, demo: true },
        command,
      );
    expect(await run({ type: 'answer', unknownId: 'n1:u1', value: '2026-12-05' })).toMatchObject({
      status: 'ok',
    });
    expect(await run({ type: 'recordReply', requestId: 'r-grandma', reply: 'yes' })).toMatchObject({
      status: 'ok',
    });
    const grandma = async () =>
      computePlan(await events(), now).requests.find((r) => r.requestId === 'r-grandma');
    expect(await grandma()).toMatchObject({ state: 'confirmed' });
    expect((await grandma())?.needsCheck).toBeUndefined();
    // 健太（a）の月曜：学童からの帰りの通勤を 19:00 までにし、家の区間も 19:00 からにする（切れ目なく続く）。
    const current = foldEvents(await events()).household;
    if (!current) throw new Error('家族の情報が無い');
    const later: Household = {
      ...current,
      routines: current.routines.map((day) =>
        day.weekday === 1 && day.memberId === 'a'
          ? {
              ...day,
              segments: day.segments.map((s) =>
                s.end === '18:15'
                  ? { ...s, end: '19:00' }
                  : s.start === '18:15'
                    ? { ...s, start: '19:00' }
                    : s,
              ),
            }
          : day,
      ),
    };
    const shown = previewHousehold(await events(), { memberId: 'b', now }, later);
    if ('reason' in shown) throw new Error(shown.reason);
    expect(shown.changes.windows).toEqual([
      expect.objectContaining({
        before: { start: '2026-12-07T08:10+09:00', end: '2026-12-07T18:15+09:00' },
        after: { start: '2026-12-07T08:10+09:00', end: '2026-12-07T19:00+09:00' },
      }),
    ]);
    expect(shown.changes.checks.map((r) => r.requestId)).toEqual(['r-grandma']);
    expect(
      await run({
        type: 'updateHousehold',
        household: later,
        seen: { throughSeq: shown.throughSeq, changes: shown.seen },
      }),
    ).toMatchObject({ status: 'ok' });
    expect(await grandma()).toMatchObject({ needsCheck: true });
  });

  it('一日の最後の区間の後は家にいるとする：最後の家の区間を短くしても、手配の要る時間は変わらない', async () => {
    const app = await setup();
    const h = await app.household();
    // 健太（a）の月曜：最後の家の区間（18:15–22:00）を 18:15–18:20 にする。その後も家にいるとして計算する。
    const shorter: Household = {
      ...h,
      routines: h.routines.map((day) =>
        day.weekday === 1 && day.memberId === 'a'
          ? {
              ...day,
              segments: day.segments.map((s, i, all) =>
                i === all.length - 1 && s.kind === 'home' ? { ...s, end: '18:20' } : s,
              ),
            }
          : day,
      ),
    };
    const shown = await app.preview(shorter);
    if ('reason' in shown) throw new Error(shown.reason);
    expect(shown.changes.windows).toEqual([]);
  });

  it('時間を直していない店の、調べた所と時刻は今の記録のまま（送られた値を採らない）', async () => {
    const app = await setup();
    const h = await app.household();
    const target = h.places.find((p) => p.id === 'store-super-toyosu');
    if (!target?.hours) throw new Error('店の営業時間が無い');
    const before = structuredClone(target.hours);
    target.hours = { ...target.hours, source: 'officialSite', checkedAt: '2026-11-25T19:00+09:00' };
    const shown = await app.preview(h);
    if ('reason' in shown) throw new Error(shown.reason);
    const { throughSeq } = computePlan(await app.events(), NOW);
    expect(
      await app.run({
        type: 'updateHousehold',
        household: h,
        seen: { throughSeq, changes: shown.seen },
      }),
    ).toMatchObject({ status: 'ok' });
    const saved = foldEvents(await app.events()).household?.places.find((p) => p.id === target.id);
    expect(saved?.hours).toEqual(before);
  });
});
