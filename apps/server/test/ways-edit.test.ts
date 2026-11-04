// 家族がやり方を足す・直す・やめる（updateHousehold の ways と stoppedWayIds。02-foundation §3.4・§6）。保存は、
// 見た「この変更で変わること」と今の同じ計算が同じ時だけ。直したやり方を使っていた選び・引き受け・送った依頼は、
// 前の物を当てない（選び直し・確かめ直し・確かめ。取り消しとは言わない）。やめるのはこれからの選びだけで、今の
// 選び・作業・依頼は替えない。分からない費用と、行ける時間の分からない場所は、勧める理由にしない。架空のデモの家。
import {
  type Household,
  type NeedInterpretation,
  needStep,
  notificationHistory,
  notificationIntents,
  proposalSnapshot,
  type SaveablePreview,
  type Task,
  todayCards,
  type Way,
} from '@maniau/core';
import { computePlan } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { sendGate } from '../src/gate';
import { previewChange } from '../src/preview';
import { memoryStore } from '../src/store';

const NOW = '2026-11-25T20:00+09:00';
const TEXT = 'あしたは8時から18時まで、だれかが家で陽菜を見ないといけない。';
const NEED: NeedInterpretation = {
  what: '陽菜を家で見る',
  shape: 'window',
  date: '2026-11-26',
  startTime: '08:00',
  endTime: '18:00',
  forMemberId: 'c',
};

/** 近所の人に来てもらう（家族が足すやり方。相手は新しく登録する手伝いの人）。費用の円は分からない。 */
const NEIGHBOR: Way = {
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
      deadline: { type: 'daysBefore', days: 1, at: '21:00' },
    },
  ],
  cost: { leaveMinutes: 0, helperRequests: 1, yen: 0, extraTasks: 0, unknown: ['yen'] },
};
const YAMADA = { id: 'yamada', kind: 'helper' as const, name: '山田さん', active: true };

/** デモの家（初めの家の情報を替えれば、替えた物。試験の材料だけ）。 */
async function setup(initial: (h: Household) => void = () => {}) {
  const store = memoryStore(
    new Map([
      [
        'demo',
        demoEvents('arrived').map((e) => {
          if (e.type !== 'householdSet') return e;
          const household = structuredClone(e.household);
          initial(household);
          return { ...e, household };
        }),
      ],
    ]),
  );
  const events = () => store.withHousehold('demo', (log) => [...log.events()]);
  let sequence = 0;
  const run = (command: Parameters<typeof runCommand>[3], memberId = 'b', now = NOW) =>
    runCommand(
      store,
      'demo',
      { memberId, now, operationId: `ways-${++sequence}`, demo: true },
      command,
    );
  const plan = async () => computePlan(await events(), NOW);
  const household = async (): Promise<Household> => {
    const found = (await events()).flatMap((e) => (e.type === 'householdSet' ? [e.household] : []));
    const last = found.at(-1);
    if (!last) throw new Error('家族の情報が無い');
    return structuredClone(last);
  };
  const preview = async (command: SaveablePreview) =>
    previewChange(await events(), { memberId: 'b', now: NOW }, command);
  /** 見てから書く（見た計画の番号と、見た物の要約を付ける）。 */
  const previewed = async (command: SaveablePreview) => {
    const shown = await preview(command);
    if ('reason' in shown) return shown;
    return run({ ...command, seen: { throughSeq: shown.throughSeq, changes: shown.seen } });
  };
  const edit = async (update: (h: Household) => void) => {
    const next = await household();
    update(next);
    return previewed({ type: 'updateHousehold', household: next });
  };
  /** 言明の「すること」（言った文で見分ける）の手配と、やり方の案・作業。 */
  const need = async (what = NEED.what) => {
    const p = await plan();
    const requirement = p.requirements.find((r) => r.kind === 'need' && r.live && r.what === what);
    const arrangement = p.arrangements.find((a) => a.live && a.requirementKey === requirement?.key);
    const option = (wayId: string) => arrangement?.options.find((o) => o.templateId === wayId);
    const task = (wayId: string): Task | undefined =>
      p.tasks.find((t) => t.live && t.basis.optionKey === option(wayId)?.key && !t.extra);
    return { plan: p, requirement, arrangement, option, task };
  };
  const stated = async (wayIds: string[], interpretation: NeedInterpretation = NEED) => {
    expect(
      await previewed({
        type: 'stateNeed',
        text: `${interpretation.what}。${TEXT}`,
        interpretation,
      }),
    ).toMatchObject({ status: 'ok' });
    const itemId = (await need(interpretation.what)).requirement?.basis.itemIds[0];
    if (!itemId) throw new Error('言明の「すること」が無い');
    if (wayIds.length > 0) {
      expect(await previewed({ type: 'setNeedWays', itemId, wayIds })).toMatchObject({
        status: 'ok',
      });
    }
    return itemId;
  };
  const choose = async (wayId: string, role: 'primary' | 'backup' = 'primary', what?: string) => {
    const { arrangement, option } = await need(what);
    return run({
      type: 'chooseOption',
      arrangementKey: arrangement?.key ?? '',
      optionKey: option(wayId)?.key ?? '',
      role,
      ...(role === 'primary' ? { assigneeId: 'b' } : {}),
    });
  };
  const accept = async (task: Task | undefined) => {
    const shown = task && proposalSnapshot(task);
    if (!task || !shown) throw new Error('引き受けられる作業が無い');
    return run({ type: 'accept', taskKey: task.key, shown });
  };
  const sent = async (task: Task | undefined, requestId: string) => {
    const { arrangement } = await need();
    if (!task || !arrangement) throw new Error('頼む作業が無い');
    return run({
      type: 'recordSent',
      taskKey: task.key,
      requestId,
      window: { start: arrangement.start, end: arrangement.end },
    });
  };
  /** 計画の検証の違反と、知らせの門（家庭の知らせを全部止めるか）。 */
  const checked = async (at = NOW) => {
    const all = await events();
    const p = computePlan(all, at);
    const h = await household();
    const violations = verifyPlan({ household: h, plan: p, events: all }).issues.filter(
      (i) => i.kind === 'violation',
    );
    const intents = notificationIntents(p, h, notificationHistory(all));
    const gate = sendGate({
      household: h,
      plan: p,
      events: all,
      intents,
      batchEnds: all.map((e) => e.seq),
    });
    return { violations, all: gate.all };
  };
  return {
    events,
    run,
    plan,
    household,
    preview,
    previewed,
    edit,
    need,
    stated,
    choose,
    accept,
    sent,
    checked,
  };
}

describe('家族がやり方を足す', () => {
  it('手伝いの人の登録と一緒に足し、「すること」に選んで本命にでき、作業はその人に頼む物になる', async () => {
    const app = await setup();
    const itemId = await app.stated([]);
    expect(
      await app.edit((h) => {
        h.members.push(YAMADA);
        h.ways.push(NEIGHBOR);
      }),
    ).toMatchObject({ status: 'ok' });
    const saved = await app.household();
    expect(saved.members.find((m) => m.id === 'yamada')).toMatchObject({ kind: 'helper' });
    expect(saved.ways.find((w) => w.id === 'way-neighbor')).toEqual(NEIGHBOR);
    expect(
      await app.previewed({ type: 'setNeedWays', itemId, wayIds: ['way-neighbor'] }),
    ).toMatchObject({ status: 'ok' });
    // 案が一つなら、費用が分からなくても「選べる案が一つ」として勧める（費用で比べていない）。
    expect((await app.need()).arrangement?.recommendedReason).toBe('onlyOption');
    expect(await app.choose('way-neighbor')).toMatchObject({ status: 'ok' });
    const task = (await app.need()).task('way-neighbor');
    expect(task?.assigneeId).toBe('b');
    expect(task?.step?.templateId).toBe('way-neighbor');
    expect((await app.checked()).violations).toEqual([]);
  });

  it('費用の分からない案があり、案が二つ以上なら勧めない（分からない欄を 0 として比べない）', async () => {
    const app = await setup();
    await app.edit((h) => {
      h.members.push(YAMADA);
      h.ways.push(NEIGHBOR);
    });
    await app.stated(['way-neighbor', 'way-grandma']);
    const { arrangement } = await app.need();
    expect(arrangement?.options).toHaveLength(2);
    expect(arrangement?.status).toBe('decidable');
    expect(arrangement?.recommendedOptionKey).toBeUndefined();
    // 費用を分かる物にすれば、比べて勧める。
    await app.edit((h) => {
      const way = h.ways.find((w) => w.id === 'way-neighbor');
      if (way) way.cost = { leaveMinutes: 0, helperRequests: 1, yen: 1000, extraTasks: 0 };
    });
    await app.stated(['way-neighbor', 'way-grandma'], {
      ...NEED,
      what: 'もう一日、陽菜を見る',
      date: '2026-11-27',
    });
    expect(
      (await app.need('もう一日、陽菜を見る')).arrangement?.recommendedOptionKey,
    ).toBeDefined();
  });

  it('本命が断られ、残る案に代償の分からない物があれば勧めないが、選び直しは要る（札に出す）', async () => {
    const app = await setup();
    await app.edit((h) => {
      h.members.push(YAMADA);
      h.ways.push(NEIGHBOR);
    });
    await app.stated(['way-sick-care', 'way-grandma', 'way-neighbor']);
    expect(await app.choose('way-grandma')).toMatchObject({ status: 'ok' });
    const ask = (await app.need()).task('way-grandma');
    expect(await app.accept(ask)).toMatchObject({ status: 'ok' });
    expect(await app.sent(ask, 'r-grandma')).toMatchObject({ status: 'ok' });
    expect(
      await app.run({ type: 'recordReply', requestId: 'r-grandma', reply: 'no' }),
    ).toMatchObject({ status: 'ok' });
    const { arrangement, plan } = await app.need();
    if (!arrangement) throw new Error('手配が無い');
    expect(arrangement.reasons.map((r) => r.code)).toContain('turnedDown');
    expect(arrangement.inUseOptionKey).toBeUndefined();
    expect(arrangement.recommendedOptionKey).toBeUndefined();
    // 勧めが無くても、選び直す時（前は勧めがあることで選び直しを示していた）。
    expect(needStep(arrangement)).toBe('choose');
    for (const member of ['a', 'b']) {
      expect(
        todayCards(plan, member).main.some(
          (c) => c.kind === 'need' && c.arrangement.key === arrangement.key,
        ),
      ).toBe(true);
    }
    expect((await app.checked()).violations).toEqual([]);
  });

  /**
   * 彩の職場で届けを出すやり方（ふだんの仕事の区間に置ける、決まった場所の手順）を家族が足し、締切の「すること」に
   * 選ぶ。職場の行ける時間（hours）を、初めの家の情報で替えて比べる。
   */
  const office = async (hours?: NonNullable<Household['places'][number]['hours']>) => {
    // 開店と閉店が同じ時刻の書き方は、初めの家の情報にしか無い（直す命令は断る）ので、やり方も初めに入れる。
    const app = await setup((h) => {
      const place = h.places.find((p) => p.id === 'work-b');
      if (place && hours) place.hours = hours;
      h.ways.push({
        id: 'way-office',
        name: '職場の総務に届けを出す',
        steps: [
          {
            id: 'submit',
            name: '総務の窓口に届けを出す',
            durationMin: 10,
            segments: ['work'],
            placeId: 'work-b',
            assigneeId: 'b',
            waitAfterMin: 0,
          },
        ],
        cost: { leaveMinutes: 0, helperRequests: 0, yen: 0, extraTasks: 0 },
      });
    });
    const what = '職場に届けを出す';
    await app.stated(['way-office'], {
      what,
      shape: 'by',
      date: '2026-12-04',
      deadline: '2026-12-04T17:00+09:00',
    });
    const { arrangement } = await app.need(what);
    // 置ける案（決め時がある）だけを比べる。
    expect(arrangement?.options).toHaveLength(1);
    expect(arrangement?.options[0]?.decisionDeadline).toBeDefined();
    expect(arrangement?.status).toBe('decidable');
    const { violations } = await app.checked();
    expect(violations.map((v) => v.code)).toEqual([]);
    return arrangement;
  };
  const weekdays = (open: string, close: string) =>
    ([1, 2, 3, 4, 5] as const).map((weekday) => ({ weekday, open, close }));

  it('行ける時間を確かめていない場所でする手順の案は、一つだけでも勧めない（間に合うとは言わない）', async () => {
    // 営業時間の登録が無い・地図から得た時間だけ・開店と閉店が同じ時刻の書き方。
    for (const hours of [
      undefined,
      { periods: weekdays('09:00', '17:00'), closedDates: [], source: 'googlePlaces' as const },
      { periods: weekdays('09:00', '09:00'), closedDates: [], source: 'family' as const },
    ]) {
      expect((await office(hours))?.recommendedOptionKey).toBeUndefined();
    }
  });

  it('家族が確かめた営業時間の場所なら、選べる案が一つとして勧める', async () => {
    // 学童（家族が確かめた営業時間）で、迎えの時に先生に書類を渡す（ふだんの迎えの区間に置ける）。職場に営業時間を
    // 入れて比べると、前からある休みの申請の作業（職場の区間に、営業時間で絞らずに置く）まで営業時間で確かめられ、
    // この試験の外の違反になるので、使わない。
    const app = await setup((h) => {
      h.ways.push({
        id: 'way-gakudo-paper',
        name: '学童の先生に書類を渡す',
        steps: [
          {
            id: 'hand',
            name: '迎えの時に先生に書類を渡す',
            durationMin: 5,
            segments: ['pickup'],
            placeId: 'gakudo',
            assigneeId: 'b',
            waitAfterMin: 0,
          },
        ],
        cost: { leaveMinutes: 0, helperRequests: 0, yen: 0, extraTasks: 0 },
      });
    });
    const what = '学童に書類を出す';
    await app.stated(['way-gakudo-paper'], {
      what,
      shape: 'by',
      date: '2026-12-04',
      deadline: '2026-12-04T17:00+09:00',
    });
    const { arrangement } = await app.need(what);
    expect(arrangement?.options[0]?.decisionDeadline).toBeDefined();
    expect(arrangement?.recommendedReason).toBe('onlyOption');
    expect((await app.checked()).violations).toEqual([]);
  });

  it('消す・未登録の相手や担当・家を場所にする・形の違う ID・分からない欄に値・大人を足す・家を足す・無いやり方をやめるは断る', async () => {
    const app = await setup();
    const h = await app.household();
    const refused = async (edited: Household, reason: string) => {
      expect(await app.preview({ type: 'updateHousehold', household: edited })).toMatchObject({
        status: 'invalid',
        reason,
      });
    };
    const withWay = (way: Way, extra: (x: Household) => void = () => {}): Household => {
      const next = structuredClone(h);
      next.members.push(YAMADA);
      next.ways.push(way);
      extra(next);
      return next;
    };
    const step = NEIGHBOR.steps[0];
    if (!step) throw new Error('手順が無い');
    await refused({ ...h, ways: h.ways.filter((w) => w.id !== 'way-grandma') }, 'wayRemoved');
    await refused(
      withWay({ ...NEIGHBOR, steps: [{ ...step, external: { to: 'nobody', kind: 'reply' } }] }),
      'householdInvalid',
    );
    // 外の相手に、家族の大人を入れない（大人は担当）。担当は有効な大人だけ。
    await refused(
      withWay({ ...NEIGHBOR, steps: [{ ...step, external: { to: 'a', kind: 'reply' } }] }),
      'wayRefUnknown',
    );
    await refused(withWay({ ...NEIGHBOR, steps: [{ ...step, assigneeId: 'c' }] }), 'wayRefUnknown');
    await refused(withWay({ ...NEIGHBOR, steps: [{ ...step, placeId: 'home' }] }), 'wayRefUnknown');
    await refused(withWay({ ...NEIGHBOR, id: 'way:neighbor' }), 'wayInvalid');
    await refused(withWay({ ...NEIGHBOR, steps: [{ ...step, id: 'a:b' }] }), 'wayInvalid');
    await refused(withWay({ ...NEIGHBOR, steps: [{ ...step, name: ' ' }] }), 'wayInvalid');
    await refused(
      withWay({ ...NEIGHBOR, cost: { ...NEIGHBOR.cost, yen: 500, unknown: ['yen'] } }),
      'wayInvalid',
    );
    await refused(
      withWay({ ...NEIGHBOR, cost: { ...NEIGHBOR.cost, unknown: ['yen', 'yen'] } }),
      'wayInvalid',
    );
    await refused(
      {
        ...h,
        members: [...h.members, { id: 'x', kind: 'adult', name: '架空の大人', active: true }],
      },
      'membersLocked',
    );
    await refused({ ...h, members: [...h.members, { ...YAMADA, id: 'home' }] }, 'membersLocked');
    await refused(
      { ...h, places: [...h.places, { id: 'home2', kind: 'home', name: '別の家', goods: [] }] },
      'placesLocked',
    );
    await refused({ ...h, stoppedWayIds: ['way-nothing'] }, 'wayInvalid');
    // 代償の「分からない」は、家族が足すやり方だけ（取れる手には付けない）。
    await refused(
      {
        ...h,
        careOptions: h.careOptions.map((o) =>
          o.id === 'opt-grandma' ? { ...o, cost: { ...o.cost, yen: 0, unknown: ['yen'] } } : o,
        ),
      },
      'careOptionsLocked',
    );
  });

  it('同じ名前の人・場所は新しく重ねられない。前からある重なりは、ほかの直しを止めず、選んであった物は残せるが、新しくは選べない', async () => {
    const app = await setup();
    const h = await app.household();
    const step = NEIGHBOR.steps[0];
    if (!step) throw new Error('手順が無い');
    // 今の頼める人と同じ名前（前後の空白は同じとみなす）・大人と同じ名前の場所（種類をまたいでも）は断る。
    for (const edited of [
      { ...h, members: [...h.members, { ...YAMADA, name: ' おばあちゃん ' }] },
      {
        ...h,
        places: [...h.places, { id: 'p-aya', kind: 'other' as const, name: '彩', goods: [] }],
      },
    ]) {
      expect(await app.preview({ type: 'updateHousehold', household: edited })).toMatchObject({
        status: 'invalid',
        reason: 'nameTaken',
      });
    }
    // 初めの家の情報に、同じ名前の二人（前からある重なり）と、その一人に頼むやり方がある。
    const legacy = await setup((x) => {
      x.members.push(YAMADA, { ...YAMADA, id: 'yamada2' });
      x.ways.push(NEIGHBOR);
    });
    expect(
      await legacy.edit((x) => {
        const way = x.ways.find((w) => w.id === 'way-apply-online');
        if (way) way.name = '区のサイトで申し込む';
      }),
    ).toMatchObject({ status: 'ok' });
    expect(
      await legacy.edit((x) => {
        const way = x.ways.find((w) => w.id === 'way-neighbor');
        if (way) way.name = '近所の山田さんに頼む';
      }),
    ).toMatchObject({ status: 'ok' });
    const next = await legacy.household();
    next.ways.push({
      ...NEIGHBOR,
      id: 'way-neighbor-2',
      steps: [{ ...step, external: { to: 'yamada2', kind: 'reply' } }],
    });
    expect(await legacy.preview({ type: 'updateHousehold', household: next })).toMatchObject({
      status: 'invalid',
      reason: 'nameTaken',
    });
  });

  it('前からある同じ名前の組へ、別の物を入れない（足す・名前を変えて入れる・一人と入れ替える）。組を減らす直しはできる', async () => {
    const legacy = await setup((x) => {
      x.members.push(YAMADA, { ...YAMADA, id: 'yamada2' });
    });
    const refused = { status: 'invalid', reason: 'nameTaken' };
    const changed = async (update: (h: Household) => void) => {
      const next = await legacy.household();
      update(next);
      return next;
    };
    const rename = (h: Household, id: string, name: string) => {
      const member = h.members.find((m) => m.id === id);
      if (!member) throw new Error(`${id} がいない`);
      member.name = name;
    };
    expect(
      (await legacy.household()).ways.some((w) => w.steps.some((s) => s.external?.to === 'g')),
    ).toBe(true);
    for (const next of [
      // 三人目を足す。
      await changed((h) => h.members.push({ ...YAMADA, id: 'yamada3' })),
      // やり方で頼んでいる相手（今は見分けられる）を、同じ名前に変える（前後の空白は同じとみなす）。
      await changed((h) => rename(h, 'g', ' 山田さん')),
      // 一人は名前を変えて出し、別の人が入る（同じ名前の数は変わらないが、組は新しい）。
      await changed((h) => {
        rename(h, 'yamada2', '山田さん（二丁目）');
        rename(h, 'g', '山田さん');
      }),
    ]) {
      expect(await legacy.preview({ type: 'updateHousehold', household: next })).toMatchObject(
        refused,
      );
      // 書く道へ直接送っても、同じ理由で断る（今の番号を添えて）。
      const throughSeq = (await legacy.plan()).throughSeq;
      expect(
        await legacy.run({
          type: 'updateHousehold',
          household: next,
          seen: { throughSeq, changes: 'x' },
        }),
      ).toMatchObject(refused);
    }
    // 組を減らす直し（一人を見分けられる名前にする）はできる。
    expect(await legacy.edit((h) => rename(h, 'yamada2', '山田さん（二丁目）'))).toMatchObject({
      status: 'ok',
    });
  });

  it('空の「分からない」は書かず、直していないやり方は初めの版のまま', async () => {
    const app = await setup();
    const before = await app.household();
    expect(
      await app.edit((h) => {
        h.members.push(YAMADA);
        h.ways.push({ ...NEIGHBOR, cost: { ...NEIGHBOR.cost, unknown: [] } });
      }),
    ).toMatchObject({ status: 'ok' });
    const after = await app.household();
    expect(after.ways.find((w) => w.id === 'way-neighbor')?.cost).toEqual({
      leaveMinutes: 0,
      helperRequests: 1,
      yen: 0,
      extraTasks: 0,
    });
    expect(after.ways.filter((w) => w.id !== 'way-neighbor')).toEqual(before.ways);
    expect(after.stoppedWayIds).toBeUndefined();
  });
});

describe('使っているやり方を直す', () => {
  /** 祖母に頼む手の締切を、前の日の 21 時から 20 時にする（中身が替わる）。 */
  const earlier = async (app: Awaited<ReturnType<typeof setup>>) => {
    const edited = await app.household();
    const way = edited.ways.find((w) => w.id === 'way-grandma');
    if (!way) throw new Error('祖母に頼むやり方が無い');
    way.deadline = { type: 'daysBefore', days: 1, at: '20:00' };
    return edited;
  };

  it('引き受けただけの作業は、選び直しが要ると見せ、保存すると本人に要らなくなったかを知らせる', async () => {
    const app = await setup();
    await app.stated(['way-grandma', 'way-sick-care']);
    expect(await app.choose('way-grandma')).toMatchObject({ status: 'ok' });
    const ask = (await app.need()).task('way-grandma');
    expect(await app.accept(ask)).toMatchObject({ status: 'ok' });
    const { arrangement } = await app.need();
    const edited = await earlier(app);
    const shown = await app.preview({ type: 'updateHousehold', household: edited });
    if ('reason' in shown) throw new Error(shown.reason);
    expect(shown.changes.rechoose).toEqual([arrangement?.key]);
    expect(shown.changes.released.map((r) => [r.taskKey, r.assigneeId])).toEqual([[ask?.key, 'b']]);
    expect(
      await app.run({
        type: 'updateHousehold',
        household: edited,
        seen: { throughSeq: shown.throughSeq, changes: shown.seen },
      }),
    ).toMatchObject({ status: 'ok' });
    const after = await app.need();
    expect(after.plan.released?.map((r) => [r.taskKey, r.assigneeId])).toContainEqual([
      ask?.key,
      'b',
    ]);
    expect((await app.checked()).violations).toEqual([]);
  });

  it('送った依頼は、選び直しが要ると見せ、保存すると返事待ちのまま確かめにする（取り消しとは言わない）', async () => {
    const app = await setup();
    await app.stated(['way-grandma', 'way-sick-care']);
    expect(await app.choose('way-grandma')).toMatchObject({ status: 'ok' });
    const ask = (await app.need()).task('way-grandma');
    expect(await app.accept(ask)).toMatchObject({ status: 'ok' });
    expect(await app.sent(ask, 'r-grandma')).toMatchObject({ status: 'ok' });
    const { arrangement } = await app.need();
    const edited = await earlier(app);
    const shown = await app.preview({ type: 'updateHousehold', household: edited });
    if ('reason' in shown) throw new Error(shown.reason);
    expect(shown.changes.rechoose).toEqual([arrangement?.key]);
    expect(shown.changes.checks.map((r) => r.requestId)).toEqual(['r-grandma']);
    expect(shown.changes.cancels).toEqual([]);
    expect(
      await app.run({
        type: 'updateHousehold',
        household: edited,
        seen: { throughSeq: shown.throughSeq, changes: shown.seen },
      }),
    ).toMatchObject({ status: 'ok' });
    const after = await app.need();
    expect(after.arrangement?.options).toEqual([]);
    expect(after.arrangement?.reasons).toContainEqual({
      code: 'inputMissing',
      refs: ['waysChanged'],
    });
    // 送った依頼は、返事待ちのまま、確かめが要る物にする（家族が取り消したいとは決めない）。
    expect(after.plan.requests.find((r) => r.requestId === 'r-grandma')).toMatchObject({
      state: 'awaitingReply',
      needsCheck: true,
    });
    expect((await app.checked()).violations).toEqual([]);
  });

  it('見た後に別の直しが入った・見た物と違う直しは書かない（古い画面から直さない）', async () => {
    const app = await setup();
    const edited = await app.household();
    edited.members.push(YAMADA);
    edited.ways.push(NEIGHBOR);
    const shown = await app.preview({ type: 'updateHousehold', household: edited });
    if ('reason' in shown) throw new Error(shown.reason);
    const count = (await app.events()).length;
    expect(
      await app.run({
        type: 'updateHousehold',
        household: {
          ...edited,
          ways: edited.ways.map((w) => (w.id === 'way-neighbor' ? { ...w, name: '別の名前' } : w)),
        },
        seen: { throughSeq: shown.throughSeq, changes: shown.seen },
      }),
    ).toMatchObject({ status: 'conflict', reason: 'consequencesChanged' });
    // 別の人が先に別の直し（祖母の呼び方）を保存した後で、前の画面の番号のまま保存しない（黙って戻さない）。
    expect(
      await app.edit((h) => {
        const g = h.members.find((m) => m.id === 'g');
        if (g) g.addressAs = 'おばあちゃん';
      }),
    ).toMatchObject({ status: 'ok' });
    expect(
      await app.run({
        type: 'updateHousehold',
        household: edited,
        seen: { throughSeq: shown.throughSeq, changes: shown.seen },
      }),
    ).toMatchObject({ status: 'conflict', reason: 'proposalChanged' });
    expect((await app.events()).length).toBe(count + 1);
  });
});

describe('やり方をやめる（これからの選びだけ）', () => {
  it('やめても、今の選び・作業・送った依頼と返事はそのまま、変わることは無く、検証と知らせの門を通る', async () => {
    const app = await setup();
    await app.stated(['way-grandma', 'way-sick-care']);
    expect(await app.choose('way-grandma')).toMatchObject({ status: 'ok' });
    const ask = (await app.need()).task('way-grandma');
    expect(await app.accept(ask)).toMatchObject({ status: 'ok' });
    expect(await app.sent(ask, 'r-grandma')).toMatchObject({ status: 'ok' });
    expect(
      await app.run({ type: 'recordReply', requestId: 'r-grandma', reply: 'yes' }),
    ).toMatchObject({ status: 'ok' });
    const before = await app.need();
    const edited = await app.household();
    edited.stoppedWayIds = ['way-grandma', 'way-sick-care'];
    const shown = await app.preview({ type: 'updateHousehold', household: edited });
    if ('reason' in shown) throw new Error(shown.reason);
    expect(Object.values(shown.changes).every((list) => list.length === 0)).toBe(true);
    expect(
      await app.run({
        type: 'updateHousehold',
        household: edited,
        seen: { throughSeq: shown.throughSeq, changes: shown.seen },
      }),
    ).toMatchObject({ status: 'ok' });
    const after = await app.need();
    expect(after.arrangement?.chosenOptionKey).toBe(before.arrangement?.chosenOptionKey);
    expect(after.arrangement?.options.map((o) => o.key)).toEqual(
      before.arrangement?.options.map((o) => o.key),
    );
    expect(after.plan.tasks.filter((t) => t.live)).toEqual(before.plan.tasks.filter((t) => t.live));
    expect(after.plan.requests).toEqual(before.plan.requests);
    const { violations, all } = await app.checked();
    expect(violations).toEqual([]);
    expect(all).toBe(false);
  });

  it('やめたやり方の、まだ選んでいない案は、予備の勧め・決める事の知らせの数に入れない（選んである案は残る）', async () => {
    const app = await setup();
    await app.stated(['way-grandma', 'way-sick-care']);
    expect(await app.choose('way-grandma')).toMatchObject({ status: 'ok' });
    const ask = (await app.need()).task('way-grandma');
    expect(await app.accept(ask)).toMatchObject({ status: 'ok' });
    expect(await app.sent(ask, 'r-grandma')).toMatchObject({ status: 'ok' });
    const sick = (await app.need()).option('way-sick-care')?.key;
    if (!sick) throw new Error('病児保育の案が無い');
    const about = (p: Awaited<ReturnType<typeof app.plan>>, h: Household) => ({
      cards: todayCards(p, 'b').main.filter((c) => c.kind === 'backup' && c.option.key === sick),
      intents: notificationIntents(p, h, notificationHistory([])).filter(
        (i) => i.subject.type === 'arrangement' && i.subject.optionId === sick,
      ),
    });
    // やめる前は、返事を待つ間の予備として勧めて知らせる（この試験が見る物がある）。
    const before = about(await app.plan(), await app.household());
    expect(before.cards).toHaveLength(1);
    expect(before.intents.map((i) => i.titleKey)).toEqual(['notify.backup']);
    expect(await app.edit((h) => (h.stoppedWayIds = ['way-sick-care']))).toMatchObject({
      status: 'ok',
    });
    const p = await app.plan();
    expect(p.arrangements.flatMap((a) => a.options).find((o) => o.key === sick)?.stopped).toBe(
      true,
    );
    expect(about(p, await app.household())).toEqual({ cards: [], intents: [] });
    // 選んである祖母の案と送った依頼は、そのまま。
    expect((await app.need()).arrangement?.chosenOptionKey).toBe(
      (await app.need()).option('way-grandma')?.key,
    );
    expect(p.requests.find((r) => r.requestId === 'r-grandma')).toMatchObject({ live: true });
  });

  it('選んだやり方がどれもやめた物で本命がまだなら、本命を選ばせず、やり方を選び直す所へ案内する', async () => {
    const app = await setup();
    const itemId = await app.stated(['way-sick-care']);
    expect(await app.edit((h) => (h.stoppedWayIds = ['way-sick-care']))).toMatchObject({
      status: 'ok',
    });
    const { arrangement, option } = await app.need();
    if (!arrangement) throw new Error('手配が無い');
    expect(needStep(arrangement)).toBe('waysStopped');
    expect(await app.choose('way-sick-care')).toMatchObject({ reason: 'wayInactive' });
    const intents = notificationIntents(
      await app.plan(),
      await app.household(),
      notificationHistory([]),
    );
    expect(intents.filter((i) => i.titleKey === 'notify.decide')).toEqual([]);
    expect(option('way-sick-care')?.stopped).toBe(true);
    // ほかのやり方を足せば、本命を選べる。
    expect(
      await app.previewed({
        type: 'setNeedWays',
        itemId,
        wayIds: ['way-sick-care', 'way-grandma'],
      }),
    ).toMatchObject({ status: 'ok' });
    const again = (await app.need()).arrangement;
    if (!again) throw new Error('手配が無い');
    expect(needStep(again)).toBe('choose');
    expect(await app.choose('way-grandma')).toMatchObject({ status: 'ok' });
  });

  it('やめたやり方は新しく選べない：別の「すること」に足す・まだ選んでいない案を予備にするのは断り、今の選びに残すのは受ける', async () => {
    const app = await setup();
    const itemId = await app.stated(['way-grandma', 'way-sick-care']);
    expect(await app.choose('way-grandma')).toMatchObject({ status: 'ok' });
    expect(await app.edit((h) => (h.stoppedWayIds = ['way-sick-care']))).toMatchObject({
      status: 'ok',
    });
    // やめたやり方の案があれば、勧めない（選べる案の比べに入れない）。
    expect((await app.need()).arrangement?.recommendedOptionKey).toBeUndefined();
    expect(await app.choose('way-sick-care', 'backup')).toMatchObject({
      status: 'invalid',
      reason: 'wayInactive',
    });
    // 今の選びに残すのは受ける（同じ選びなら何も書かない）。外すのも受ける。
    expect(
      await app.previewed({
        type: 'setNeedWays',
        itemId,
        wayIds: ['way-grandma', 'way-sick-care'],
      }),
    ).toMatchObject({ status: 'noop' });
    expect(
      await app.preview({ type: 'setNeedWays', itemId, wayIds: ['way-grandma'] }),
    ).toMatchObject({ changes: expect.any(Object) });
    const other = await app.stated([], {
      ...NEED,
      what: 'あさっても陽菜を見る',
      date: '2026-11-27',
    });
    expect(
      await app.preview({ type: 'setNeedWays', itemId: other, wayIds: ['way-sick-care'] }),
    ).toMatchObject({ status: 'invalid', reason: 'wayInactive' });
    expect(
      await app.previewed({ type: 'setNeedWays', itemId: other, wayIds: ['way-grandma'] }),
    ).toMatchObject({ status: 'ok' });
    // 使い直せば、また選べる。
    expect(await app.edit((h) => delete h.stoppedWayIds)).toMatchObject({ status: 'ok' });
    expect(
      await app.previewed({
        type: 'setNeedWays',
        itemId: other,
        wayIds: ['way-sick-care', 'way-grandma'],
      }),
    ).toMatchObject({ status: 'ok' });
  });
});
