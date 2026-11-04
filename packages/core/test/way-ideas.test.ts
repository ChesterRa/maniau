// 新しい「すること」に Claude がやり方の案を出す時の、モデルに渡す物と、モデルの出力の確かめ（W4）。モデルの出力は
// 手で書いた形（呼ばない）。無い ID・文に無い名前・範囲を外れた数は、分からないにして理由を残し、黙って 0・丸め・
// 既定値にしない。外の事実（値段・返事の早さ・締切の決まり・受け持てる時間）は、出力の形に欄が無い。
import { describe, expect, it } from 'vitest';
import {
  checkWayIdeas,
  type Extraction,
  type Household,
  type Item,
  type Source,
  splitSentences,
  WAY_IDEAS_LIMITS,
  WayIdeasOutput,
  wayIdeasContext,
} from '../src';
import { computePlan, foldEvents, itemsOf } from '../src/engine';
import { household, noticeArrived } from './fixtures/demo';

const TEXT =
  '12月12日（土）13:00〜14:00に地域交流会を行います。各家庭から大人1名、ご参加ください。';
const AT = '2026-11-25T20:00+09:00';
const NOW = '2026-11-25T21:00+09:00';
const ID = 'n9:i1';

const source: Source = {
  id: 'n9',
  version: 1,
  receivedAt: AT,
  sender: 'school',
  language: 'ja',
  medium: 'text',
  sentences: splitSentences(TEXT, 'n9'),
};
const need: Item = {
  id: ID,
  sourceId: 'n9',
  sentenceIds: ['n9#1', 'n9#2'],
  kind: 'need',
  written: '各家庭から大人1名、ご参加ください。',
  interpretation: {
    date: '2026-12-12',
    startTime: '13:00',
    endTime: '14:00',
    what: '地域交流会への参加',
    shape: 'window',
  },
  evidence: 'stated',
  effects: [],
};
const extraction: Extraction = {
  sourceId: 'n9',
  items: [need],
  unknowns: [],
  conditions: [],
  irrelevantSentenceIds: [],
  ambiguities: [],
};

/** 交流会のお知らせを読み、家族が確かめた所（計画に入っている）。 */
function materials(confirmed = true) {
  let log = noticeArrived()
    .add('noticeReceived', AT, 'b', { source })
    .add('modelOutputRecorded', AT, 'system', {
      call: 'extract',
      model: 'hand-written',
      promptVersion: 'fixture',
      inputHash: 'fixture-n9',
      sourceId: 'n9',
      output: extraction,
    });
  if (confirmed) log = log.add('itemConfirmed', NOW, 'b', { itemId: ID });
  const state = foldEvents(log.events);
  const plan = computePlan(log.events, NOW);
  if (!state.household) throw new Error('家の情報が無い');
  return {
    plan,
    items: itemsOf(state),
    household: state.household,
    sources: [...state.sources.values()],
  };
}
const keyOf = (plan: ReturnType<typeof computePlan>) => {
  const requirement = plan.requirements.find((r) => r.basis.itemIds.includes(ID));
  return plan.arrangements.find((a) => a.requirementKey === requirement?.key)?.key ?? 'none';
};

describe('モデルに渡す物', () => {
  it('「すること」の欄と元の文、家の人・頼める人・場所・やり方の名前と ID だけを渡す', () => {
    const m = materials();
    const context = wayIdeasContext(m, keyOf(m.plan), '  祖母に頼めるかも。 ', 'ja', 'b');
    expect(context?.need).toEqual({
      what: '地域交流会への参加',
      shape: 'window',
      date: '2026-12-12',
      start: '13:00',
      end: '14:00',
      by: null,
      place: null,
      written: TEXT,
    });
    expect(context?.familyWords).toBe('祖母に頼めるかも。');
    // 考えの「私」がだれかは、頼んだ大人（考えが無ければ渡さない）。
    expect(context?.familyWordsBy).toEqual({ id: 'b', name: '彩' });
    expect(wayIdeasContext(m, keyOf(m.plan), '  ', 'ja', 'b')?.familyWordsBy).toBeNull();
    expect(context?.household.adults).toEqual([
      { id: 'a', name: '健太' },
      { id: 'b', name: '彩' },
    ]);
    expect(context?.household.helpers).toEqual([{ id: 'g', name: 'おばあちゃん' }]);
    expect(context?.household.places.some((p) => p.kind === 'home')).toBe(false);
    expect(context?.household.ways.map((w) => w.id)).toContain('way-grandma');
    // 子の名前・住所・ふだんの予定は渡さない。
    expect(JSON.stringify(context?.household)).not.toContain('陽菜');
    expect(JSON.stringify(context?.household)).not.toContain('routine');
  });

  it('止めたやり方は渡さない。家族の考えは上限で切る', () => {
    const m = materials();
    const stopped = { ...m, household: { ...m.household, stoppedWayIds: ['way-grandma'] } };
    const context = wayIdeasContext(stopped, keyOf(m.plan), 'あ'.repeat(600), 'ja', 'b');
    expect(context?.household.ways.map((w) => w.id)).not.toContain('way-grandma');
    expect(context?.familyWords).toHaveLength(WAY_IDEAS_LIMITS.familyWords);
  });

  it('手配が無い・まだ確かめていない読み取り（手配が無い）なら作らない', () => {
    const m = materials();
    expect(wayIdeasContext(m, 'arr:need:none', undefined, 'ja', 'b')).toBeUndefined();
    const unconfirmed = materials(false);
    expect(
      wayIdeasContext(unconfirmed, keyOf(unconfirmed.plan), undefined, 'ja', 'b'),
    ).toBeUndefined();
  });
});

const step = (over: Partial<WayIdeasOutput['drafts'][number]['steps'][number]> = {}) => ({
  name: '祖母に来てもらえるか聞く',
  quote: '祖母に頼めるかも',
  assignee: { kind: 'adult' as const, id: 'b' },
  counterpart: { kind: 'helper' as const, id: 'g', name: null, quote: null },
  place: { kind: 'none' as const, id: null, name: null, quote: null },
  minutes: 5,
  segments: ['home', 'work'] as ('home' | 'work')[],
  cover: true,
  ...over,
});
const draft = (over: Partial<WayIdeasOutput['drafts'][number]> = {}) => ({
  name: '祖母に出てもらう',
  why: '祖母が交流会に出る',
  steps: [step()],
  covers: 'whole' as const,
  cost: { leaveMinutes: null, extraTasks: null },
  unclear: ['祖母が出てよい会か、お知らせには書かれていません'],
  ...over,
});
const check = (output: Partial<WayIdeasOutput>, shape: 'by' | 'window' = 'window') => {
  const m = materials();
  const context = wayIdeasContext(m, keyOf(m.plan), '祖母に頼めるかも。', 'ja', 'b');
  if (!context) throw new Error('前提が無い');
  return checkWayIdeas(
    { drafts: [], reuse: [], missing: [], ...output },
    { ...context, need: { ...context.need, shape } },
    household,
  );
};

describe('モデルの出力の確かめ', () => {
  it('今の家庭の ID と、文にある引用はそのまま使う', () => {
    const checked = check({ drafts: [draft()] });
    expect(checked.drafts[0]?.steps[0]).toEqual({
      name: '祖母に来てもらえるか聞く',
      quote: '祖母に頼めるかも',
      quoteFrom: 'words',
      assignee: { kind: 'adult', id: 'b' },
      counterpart: { kind: 'helper', id: 'g' },
      place: { kind: 'none' },
      minutes: 5,
      segments: ['home', 'work'],
      cover: true,
    });
    expect(checked.drafts[0]?.notes).toEqual([]);
    expect(checked.drafts[0]?.covers).toBe('whole');
    expect(checked.drafts[0]?.cost).toEqual({
      leaveMinutes: null,
      helperRequests: 1,
      extraTasks: null,
    });
  });

  it('引用の出どころはコードが決める（元の文・家族の考え・両方）', () => {
    const m = materials();
    const context = wayIdeasContext(m, keyOf(m.plan), '地域交流会は祖母に頼めるかも。', 'ja', 'b');
    if (!context) throw new Error('前提が無い');
    const checked = checkWayIdeas(
      {
        drafts: [
          draft({
            steps: [
              step({ quote: '各家庭から大人1名' }),
              step({ quote: '祖母に頼めるかも' }),
              step({ quote: '地域交流会' }),
            ],
          }),
        ],
        reuse: [],
        missing: [],
      },
      context,
      household,
    );
    expect(checked.drafts[0]?.steps.map((s) => s.quoteFrom)).toEqual(['written', 'words', 'both']);
  });

  it('外の事実（値段・返事の早さ・締切の決まり・受け持てる時間）は、出力の形に欄が無く、書いても受け取らない', () => {
    const shape = WayIdeasOutput.shape.drafts.element.shape;
    expect(Object.keys(shape.cost.shape)).toEqual(['leaveMinutes', 'extraTasks']);
    expect(Object.keys(shape.steps.element.shape)).not.toContain('replyWaitMinutes');
    expect(Object.keys(shape.steps.element.shape)).not.toContain('deadline');
    expect(shape.covers.options).toEqual(['whole', 'unknown']);
    // 形に無い欄をモデルが書いても、読み込む時に落ちる（確かめた案にも出ない）。
    const parsed = WayIdeasOutput.parse({
      drafts: [
        {
          ...draft(),
          cost: { leaveMinutes: null, extraTasks: null, yen: 1500, helperRequests: 5 },
          steps: [
            {
              ...step(),
              replyWaitMinutes: 1440,
              deadline: { kind: 'daysBefore', days: 2, at: '21:00' },
            },
          ],
        },
      ],
      reuse: [],
      missing: [],
    });
    const checked = check(parsed);
    expect(JSON.stringify(checked)).not.toMatch(/yen|1500|replyWait|1440|deadline/);
    expect(checked.drafts[0]?.cost.helperRequests).toBe(1);
    expect(
      WayIdeasOutput.safeParse({ ...parsed, drafts: [{ ...draft(), covers: 'part' }] }).success,
    ).toBe(false);
  });

  it('頼める人に頼む数は手順から数える。相手の分からない手順があれば数えない', () => {
    const counted = check({
      drafts: [
        draft({
          steps: [
            step(),
            step({
              counterpart: { kind: 'newHelper', id: null, name: '祖母', quote: '祖母に頼めるかも' },
            }),
            step({ counterpart: { kind: 'none', id: null, name: null, quote: null } }),
          ],
        }),
        draft({
          steps: [
            step(),
            step({ counterpart: { kind: 'unknown', id: null, name: null, quote: null } }),
          ],
        }),
      ],
    });
    expect(counted.drafts[0]?.cost.helperRequests).toBe(2);
    expect(counted.drafts[1]?.cost.helperRequests).toBeNull();
  });

  it('by の「すること」では、どの手順も窓を受け持たない', () => {
    const checked = check(
      { drafts: [draft({ steps: [step({ cover: true }), step({ cover: null })] })] },
      'by',
    );
    expect(checked.drafts[0]?.steps.map((s) => s.cover)).toEqual([false, false]);
  });

  it('無い ID は分からないにする。文に無い引用は外し、空の引用は引用が無いのと同じ', () => {
    const checked = check({
      drafts: [
        draft({
          steps: [
            step({
              assignee: { kind: 'adult', id: 'zz' },
              counterpart: { kind: 'helper', id: 'nobody', name: null, quote: null },
              place: { kind: 'place', id: 'home', name: null, quote: null },
              quote: '書かれていない文',
            }),
            step({ quote: '' }),
          ],
        }),
      ],
    });
    const [first, second] = checked.drafts[0]?.steps ?? [];
    expect(first?.assignee).toEqual({ kind: 'unknown' });
    expect(first?.counterpart).toEqual({ kind: 'unknown' });
    expect(first?.place).toEqual({ kind: 'unknown' });
    expect(first?.quote).toBeNull();
    expect(second?.quote).toBeNull();
    expect(checked.drafts[0]?.notes).toEqual([
      { code: 'quoteNotInText', value: '書かれていない文' },
      { code: 'unknownId', value: 'zz' },
      { code: 'unknownId', value: 'nobody' },
      { code: 'unknownId', value: 'home' },
    ]);
  });

  it('新しい相手・場所の名前は、文にある引用の中の名前だけ使う（作った施設を登録させない）', () => {
    const checked = check({
      drafts: [
        draft({
          steps: [
            step({
              counterpart: { kind: 'newHelper', id: null, name: '祖母', quote: '祖母に頼めるかも' },
            }),
            step({
              counterpart: {
                kind: 'newPlace',
                id: null,
                name: 'みらい橋ファミリーサポート',
                quote: null,
              },
            }),
          ],
        }),
      ],
    });
    const [named, invented] = checked.drafts[0]?.steps ?? [];
    expect(named?.counterpart).toEqual({ kind: 'newHelper', name: '祖母' });
    expect(invented?.counterpart).toEqual({ kind: 'unknown' });
    expect(checked.drafts[0]?.notes).toContainEqual({
      code: 'nameNotInText',
      value: 'みらい橋ファミリーサポート',
    });
  });

  it('同じ名前の人・場所は、ID があっても分からないにする。今の名前と同じ新しい名前も登録させない', () => {
    const m = materials();
    const context = wayIdeasContext(m, keyOf(m.plan), 'おばあちゃんに頼めるかも。', 'ja', 'b');
    if (!context) throw new Error('前提が無い');
    const twins: Household = {
      ...household,
      members: [
        ...household.members,
        { id: 'h1', kind: 'helper', name: '山田さん', active: true },
        { id: 'h2', kind: 'helper', name: ' 山田さん', active: true },
      ],
    };
    const checked = checkWayIdeas(
      {
        drafts: [
          draft({
            steps: [
              step({
                quote: null,
                counterpart: { kind: 'helper', id: 'h1', name: null, quote: null },
              }),
              step({
                quote: null,
                counterpart: {
                  kind: 'newHelper',
                  id: null,
                  name: 'おばあちゃん',
                  quote: 'おばあちゃんに頼めるかも',
                },
              }),
            ],
          }),
        ],
        reuse: [],
        missing: [],
      },
      context,
      twins,
    );
    expect(checked.drafts[0]?.steps.map((s) => s.counterpart)).toEqual([
      { kind: 'unknown' },
      { kind: 'unknown' },
    ]);
    expect(checked.drafts[0]?.notes).toEqual([
      { code: 'ambiguousName', value: '山田さん' },
      { code: 'ambiguousName', value: 'おばあちゃん' },
    ]);
    expect(checked.drafts[0]?.cost.helperRequests).toBeNull();
  });

  it('範囲を外れた数は分からないにする（丸めない）', () => {
    const checked = check({
      drafts: [
        draft({
          steps: [step({ minutes: 2000 }), step({ minutes: 0 })],
          cost: { leaveMinutes: 45, extraTasks: -1 },
        }),
        draft({ cost: { leaveMinutes: -30, extraTasks: 0 } }),
      ],
    });
    const [d, e] = checked.drafts;
    expect(d?.steps.map((s) => s.minutes)).toEqual([null, null]);
    expect(d?.cost).toEqual({ leaveMinutes: null, helperRequests: 2, extraTasks: null });
    expect(d?.notes).toEqual([
      { code: 'outOfRange', field: 'minutes', value: 2000 },
      { code: 'outOfRange', field: 'minutes', value: 0 },
      { code: 'leaveNotHalfHour', value: 45 },
      { code: 'outOfRange', field: 'cost', value: -1 },
    ]);
    expect(e?.cost).toEqual({ leaveMinutes: null, helperRequests: 1, extraTasks: 0 });
    expect(e?.notes).toEqual([{ code: 'outOfRange', field: 'cost', value: -30 }]);
  });

  it('分からない欄は分からないのまま（既定値で埋めない）。休みは 30 分の倍数なら残す', () => {
    const checked = check({
      drafts: [
        draft({
          steps: [
            step({
              assignee: { kind: 'unknown', id: null },
              counterpart: { kind: 'unknown', id: null, name: null, quote: null },
              place: { kind: 'unknown', id: null, name: null, quote: null },
              minutes: null,
              segments: null,
              cover: null,
            }),
          ],
          covers: 'unknown',
          cost: { leaveMinutes: 90, extraTasks: null },
        }),
      ],
    });
    expect(checked.drafts[0]?.steps[0]).toMatchObject({
      assignee: { kind: 'unknown' },
      counterpart: { kind: 'unknown' },
      place: { kind: 'unknown' },
      minutes: null,
      segments: null,
      cover: null,
    });
    expect(checked.drafts[0]?.covers).toBe('unknown');
    expect(checked.drafts[0]?.cost).toEqual({
      leaveMinutes: 90,
      helperRequests: null,
      extraTasks: null,
    });
  });

  it('案と手順は上限まで。手順の無い案は捨てる。今あるやり方だけを使えると返す', () => {
    const many = check({
      drafts: [
        draft({ steps: [step(), step(), step(), step()] }),
        draft({ steps: [] }),
        draft(),
        draft(),
        draft(),
      ],
      reuse: [
        { wayId: 'way-grandma', why: '祖母に頼める' },
        { wayId: 'way-grandma', why: '重なり' },
        { wayId: 'way-none', why: '無いやり方' },
      ],
      missing: ['  ', '祖母が出てよい会か'],
    });
    expect(many.drafts).toHaveLength(2);
    expect(many.drafts[0]?.steps).toHaveLength(3);
    expect(many.drafts[0]?.notes).toContainEqual({ code: 'tooManySteps', value: 4 });
    expect(many.notes).toEqual([
      { code: 'tooManyDrafts', value: 5 },
      { code: 'noSteps' },
      { code: 'unknownWay', value: 'way-none' },
    ]);
    expect(many.reuse).toEqual([{ wayId: 'way-grandma', why: '祖母に頼める' }]);
    expect(many.missing).toEqual(['祖母が出てよい会か']);
  });

  it('案を出さない答え（0 件）も受ける', () => {
    expect(check({ missing: ['だれが出られるか'] })).toEqual({
      drafts: [],
      reuse: [],
      missing: ['だれが出られるか'],
      notes: [],
    });
  });
});
