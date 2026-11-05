// 窓の「すること」で、約束が全部そろっても受け持てると示せない時間（coverGaps）が残る手は、勧めない（選べる）。
// 覆ったかの計算（withCoverage）と同じ決まりで、前もって分かる物だけ：受け持つ手順が無い、場所の書かれた
// 「すること」に家族の受け持ちがある、受け持てる時間が窓より狭い。まだ引き受けていない・返事の無い手は勧めてよい。
// 締切の形には付けない。命令の層で、言う → やり方を選ぶ → 計画、の順に確かめる（家の情報は試験の材料だけ）。
import { type NeedInterpretation, type Task, toEpochMinutes, type Way } from '@maniau/core';
import { computePlan } from '@maniau/core/engine';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { previewChange } from '../src/preview';
import { memoryStore } from '../src/store';

const NOW = '2026-11-25T20:00+09:00';
// 土曜の午後（二人とも家にいる）。
const WINDOW: NeedInterpretation = {
  what: '点検の立ち会い',
  shape: 'window',
  date: '2026-11-28',
  startTime: '13:00',
  endTime: '15:00',
};
const sat = (time: string) => `2026-11-28T${time}+09:00`;
const cost = { leaveMinutes: 0, helperRequests: 0, yen: 0, extraTasks: 0 };

/** 受け持つ手順の無いやり方（前もってする手順だけ）。 */
const tidy: Way = {
  id: 'way-tidy',
  name: '点検の前に場所を片付ける',
  steps: [
    {
      id: 'tidy',
      name: '片付ける',
      durationMin: 30,
      segments: ['home'],
      waitAfterMin: 0,
      assigneeId: 'a',
    },
  ],
  cost,
};
/** 家族が窓の全部を受け持つやり方。 */
const homeA: Way = {
  id: 'way-home-a',
  name: '健太が家で立ち会う',
  steps: [
    {
      id: 'stay',
      name: '家で立ち会う',
      durationMin: 0,
      segments: ['home'],
      waitAfterMin: 0,
      assigneeId: 'a',
      cover: true,
    },
  ],
  cost,
};
/** 外の相手が、窓の一部（14:00–15:00）だけ受け持てるやり方。 */
const part: Way = {
  id: 'way-part',
  name: '祖母に 14 時から来てもらう',
  steps: [
    {
      id: 'ask',
      name: '来てもらうよう頼む',
      durationMin: 5,
      segments: ['home'],
      waitAfterMin: 0,
      external: { to: 'g', kind: 'reply' },
      cover: true,
    },
  ],
  covers: { start: '14:00', end: '15:00' },
  cost: { ...cost, helperRequests: 1 },
};

async function setup(extraWays: Way[]) {
  const events0 = demoEvents('arrived').map((e) => {
    if (e.type !== 'householdSet') return e;
    const household = structuredClone(e.household);
    household.ways.push(...extraWays);
    return { ...e, household };
  });
  const store = memoryStore(new Map([['demo', events0]]));
  const events = () => store.withHousehold('demo', (log) => [...log.events()]);
  let sequence = 0;
  const run = (command: Parameters<typeof runCommand>[3], memberId = 'b') =>
    runCommand(
      store,
      'demo',
      { memberId, now: NOW, operationId: `gaps-${++sequence}`, demo: true },
      command,
    );
  const plan = async () => computePlan(await events(), NOW);
  const previewed = async (command: Parameters<typeof previewChange>[2]) => {
    const shown = await previewChange(await events(), { memberId: 'b', now: NOW }, command);
    if ('reason' in shown) throw new Error(shown.reason);
    const { throughSeq } = await plan();
    return run({ ...command, seen: { throughSeq, changes: shown.seen } } as never);
  };
  const need = async () => {
    const p = await plan();
    const requirement = p.requirements.find((r) => r.kind === 'need' && r.live);
    const arrangement = p.arrangements.find((a) => a.kind === 'need' && a.live);
    const option = (wayId: string) => arrangement?.options.find((o) => o.templateId === wayId);
    const task = (wayId: string, stepId: string): Task | undefined =>
      p.tasks.find(
        (t) =>
          t.live &&
          t.basis.optionKey === option(wayId)?.key &&
          t.step?.templateId === wayId &&
          t.step.stepId === stepId,
      );
    const gaps = arrangement?.reasons.find((r) => r.code === 'notCovered')?.refs ?? [];
    return { requirement, arrangement, option, task, gaps };
  };
  const stated = async (wayIds: string[], interpretation: NeedInterpretation = WINDOW) => {
    expect(
      await previewed({ type: 'stateNeed', text: interpretation.what, interpretation }),
    ).toMatchObject({ status: 'ok' });
    const itemId = (await need()).requirement?.basis.itemIds[0];
    if (!itemId) throw new Error('言明の「すること」が無い');
    expect(await previewed({ type: 'setNeedWays', itemId, wayIds })).toMatchObject({
      status: 'ok',
    });
  };
  return { run, need, stated };
}

const minutes = (g: { start: string; end: string }) => [
  toEpochMinutes(g.start),
  toEpochMinutes(g.end),
];

describe('受け持てると示せない時間が残る手は勧めない', () => {
  it('受け持つ手順の無い手：窓の全部が残る。勧めない（ほかに手が無ければ、お勧めは無い）が、選べる', async () => {
    const app = await setup([tidy]);
    await app.stated(['way-tidy']);
    const { arrangement, option } = await app.need();
    expect(option('way-tidy')?.coverGaps?.map(minutes)).toEqual([
      [toEpochMinutes(sat('13:00')), toEpochMinutes(sat('15:00'))],
    ]);
    expect(arrangement?.status).toBe('decidable');
    expect(arrangement?.recommendedOptionKey).toBeUndefined();
    // 選べる（決め時があり、過ぎていない）。
    expect(option('way-tidy')?.expired).toBe(false);
    expect(option('way-tidy')?.decisionDeadline).toBeDefined();
  });

  it('受け持てる手があれば、そちらを勧める（受け持つ手順の無い手は比べない）', async () => {
    const app = await setup([tidy, homeA]);
    await app.stated(['way-tidy', 'way-home-a']);
    const { arrangement, option } = await app.need();
    expect(option('way-home-a')?.coverGaps).toBeUndefined();
    expect(option('way-tidy')?.coverGaps).toBeDefined();
    expect(arrangement?.recommendedOptionKey).toBe(option('way-home-a')?.key);
  });

  it('受け持てる時間が窓より狭い手：はみ出た時間だけが残り、勧めない', async () => {
    const app = await setup([part, homeA]);
    await app.stated(['way-part', 'way-home-a']);
    const { arrangement, option } = await app.need();
    expect(option('way-part')?.coverGaps?.map(minutes)).toEqual([
      [toEpochMinutes(sat('13:00')), toEpochMinutes(sat('14:00'))],
    ]);
    expect(arrangement?.recommendedOptionKey).toBe(option('way-home-a')?.key);
    // 部分の手だけなら、お勧めは無い（選ぶことはできる）。
    const only = await setup([part]);
    await only.stated(['way-part']);
    const alone = await only.need();
    expect(alone.arrangement?.recommendedOptionKey).toBeUndefined();
    expect(alone.option('way-part')?.expired).toBe(false);
  });

  it('場所の書かれた「すること」：家族の受け持ちの手は窓の全部が残り、外の相手が受け持つ手を勧める', async () => {
    const app = await setup([homeA]);
    await app.stated(['way-home-a', 'way-grandma'], { ...WINDOW, place: '公民館' });
    const { arrangement, option } = await app.need();
    expect(option('way-home-a')?.coverGaps?.map(minutes)).toEqual([
      [toEpochMinutes(sat('13:00')), toEpochMinutes(sat('15:00'))],
    ]);
    expect(option('way-grandma')?.coverGaps).toBeUndefined();
    expect(arrangement?.recommendedOptionKey).toBe(option('way-grandma')?.key);
  });

  it('覆ったかの計算と食い違わない：残りの無い手は、選んで引き受ければ覆い、残りのある手は、選んで引き受けても残る', async () => {
    const full = await setup([homeA]);
    await full.stated(['way-home-a']);
    const fullOption = (await full.need()).option('way-home-a');
    expect(fullOption?.coverGaps).toBeUndefined();
    const arrangementKey = (await full.need()).arrangement?.key ?? '';
    expect(
      await full.run({
        type: 'chooseOption',
        arrangementKey,
        optionKey: fullOption?.key ?? '',
        role: 'primary',
        assigneeId: 'a',
      }),
    ).toMatchObject({ status: 'ok' });
    const stay = (await full.need()).task('way-home-a', 'stay');
    expect(stay?.start).toBeDefined();
    const { proposalSnapshot } = await import('@maniau/core');
    const shown = stay && proposalSnapshot(stay);
    if (!stay || !shown) throw new Error('引き受けられる作業が無い');
    expect(await full.run({ type: 'accept', taskKey: stay.key, shown }, 'a')).toMatchObject({
      status: 'ok',
    });
    expect((await full.need()).gaps).toEqual([]);

    const none = await setup([tidy]);
    await none.stated(['way-tidy']);
    const tidyOption = (await none.need()).option('way-tidy');
    const key2 = (await none.need()).arrangement?.key ?? '';
    expect(
      await none.run({
        type: 'chooseOption',
        arrangementKey: key2,
        optionKey: tidyOption?.key ?? '',
        role: 'primary',
        assigneeId: 'a',
      }),
    ).toMatchObject({ status: 'ok' });
    const step = (await none.need()).task('way-tidy', 'tidy');
    const shown2 = step && proposalSnapshot(step);
    if (!step || !shown2) throw new Error('引き受けられる作業が無い');
    expect(await none.run({ type: 'accept', taskKey: step.key, shown: shown2 }, 'a')).toMatchObject(
      { status: 'ok' },
    );
    // 前もって分かった残りと、選んで引き受けた後の残りが同じ。
    expect((await none.need()).gaps.map((r) => r.split('/').map(toEpochMinutes))).toEqual(
      tidyOption?.coverGaps?.map(minutes),
    );
  });

  it('受け持つ人の決まった家族の受け持ちを、ふだんの予定では窓に置けない時は、窓の全部が残る（決まっていない時は付けない）', async () => {
    // 平日の午後（健太は仕事）。健太の受け持ちは窓に置けない。
    const weekday: NeedInterpretation = { ...WINDOW, date: '2026-11-26' };
    const fixed = await setup([homeA]);
    await fixed.stated(['way-home-a'], weekday);
    const one = await fixed.need();
    expect(one.task('way-home-a', 'stay')?.start).toBeUndefined();
    expect(one.option('way-home-a')?.coverGaps?.map(minutes)).toEqual([
      [toEpochMinutes('2026-11-26T13:00+09:00'), toEpochMinutes('2026-11-26T15:00+09:00')],
    ]);
    expect(one.arrangement?.recommendedOptionKey).toBeUndefined();
    // 受け持つ人を決めていない受け持ちは、まだ分からない（選ぶ時に決まる）ので付けない。
    const anyone: Way = {
      ...homeA,
      id: 'way-home-any',
      name: '家族のだれかが家で立ち会う',
      steps: homeA.steps.map(({ assigneeId: _who, ...step }) => step),
    };
    const open = await setup([anyone]);
    await open.stated(['way-home-any'], weekday);
    expect((await open.need()).option('way-home-any')?.coverGaps).toBeUndefined();
  });

  it('締切の形の「すること」には付けない（受け持ちの考えが無い）', async () => {
    const app = await setup([]);
    await app.stated(['way-apply-online'], {
      what: '学童の申し込み',
      shape: 'by',
      date: '2026-11-30',
      deadline: '2026-11-30T17:00+09:00',
    });
    const { option } = await app.need();
    expect(option('way-apply-online')).toBeDefined();
    expect(option('way-apply-online')?.coverGaps).toBeUndefined();
  });
});
