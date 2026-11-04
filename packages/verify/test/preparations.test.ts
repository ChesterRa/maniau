// 前提の検証は、家庭の情報と家族の言明から独立に行う。API や求解器は使わない。
import { Household, type Preparation } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { arrangement, event, household, option, plan, requirement } from './fixtures';

const SOURCE = 'source-1';
const ITEM = 'source-1:i1';
const required = (overrides: Partial<Preparation> = {}): Preparation => ({
  id: 'prep-1',
  name: '事前の登録',
  appliesTo: { kind: 'members', memberIds: ['a'] },
  state: 'unknown',
  ...overrides,
});

function materials(
  preparation = required(),
  gaps: NonNullable<
    ReturnType<typeof plan>['arrangements'][number]['options'][number]['needsPreparation']
  > = [{ preparationId: 'prep-1', state: 'unknown' }],
  memberId: string | null = 'a',
) {
  const family = Household.parse({
    ...household(),
    ways: [
      {
        id: 'way',
        name: '架空の方法',
        steps: [{ id: 'step', name: '確かめる', durationMin: 10, segments: ['home'] }],
        cost: {},
        requires: ['prep-1'],
      },
    ],
    preparations: [preparation],
  });
  const source = {
    id: SOURCE,
    version: 1,
    receivedAt: '2026-11-30T10:00+09:00',
    sender: 'family',
    language: 'ja',
    sentences: [{ id: `${SOURCE}#1`, text: 'その日に頼む。' }],
  };
  const item = {
    id: ITEM,
    sourceId: SOURCE,
    sentenceIds: [`${SOURCE}#1`],
    kind: 'need',
    written: 'その日に頼む。',
    interpretation: {
      what: '頼む',
      shape: 'window',
      date: '2026-12-07',
      startTime: '09:00',
      endTime: '17:00',
      ...(memberId === null ? {} : { forMemberId: memberId }),
    },
    evidence: 'stated',
    effects: [],
  };
  const events = [
    event(1, { type: 'householdSet', household: family }),
    event(2, { type: 'noticeReceived', source }),
    event(3, { type: 'itemsStated', sourceId: SOURCE, items: [item] }),
  ];
  const current = plan({
    throughSeq: 3,
    requirements: [requirement({ kind: 'need', basis: { itemIds: [ITEM] } })],
    arrangements: [
      arrangement({
        kind: 'need',
        needShape: 'window',
        options: [option('o', { templateId: 'way', needsPreparation: gaps })],
      }),
    ],
  });
  return { family, events, current };
}

function preparationIssues(m: ReturnType<typeof materials>) {
  return verifyPlan({ household: m.family, events: m.events, plan: m.current }).issues.filter(
    (issue) => issue.code.startsWith('preparation_') || issue.code.startsWith('resource_'),
  );
}

function gaps(m: ReturnType<typeof materials>) {
  const result = m.current.arrangements[0]?.options[0]?.needsPreparation;
  if (!result) throw new Error('前提の印がない');
  return result;
}

function firstOption(m: ReturnType<typeof materials>) {
  const result = m.current.arrangements[0]?.options[0];
  if (!result) throw new Error('案がない');
  return result;
}

function firstGap(m: ReturnType<typeof materials>) {
  const result = gaps(m)[0];
  if (!result) throw new Error('前提の印がない');
  return result;
}

function useResource(m: ReturnType<typeof materials>, use: 'candidate' | 'usual' | 'notUsed') {
  const way = m.family.ways[0];
  if (!way) throw new Error('やり方がない');
  m.family.resources.push({
    id: 'resource-1',
    kind: 'service',
    name: '架空の場所',
    notes: [],
    use,
  });
  way.resourceIds = ['resource-1'];
  m.events[0] = event(1, { type: 'householdSet', household: m.family });
  firstOption(m).unusedResources = use === 'notUsed' ? ['resource-1'] : undefined;
}

describe('やり方に必要な事前の前提を独立に照らす', () => {
  it('対象の人と状態が合えば印を認め、済んだ前提は印を消す', () => {
    expect(preparationIssues(materials())).toEqual([]);
    expect(preparationIssues(materials(required({ state: 'done' }), []))).toEqual([]);
    expect(preparationIssues(materials(required({ state: 'done' })))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'violation', code: 'preparation_mismatch' }),
      ]),
    );
  });

  it('別の人、対象不明、前提の適用先不明を済んだことにしない', () => {
    const done = required({ state: 'done' });
    const cases = [
      materials(done, [{ preparationId: 'prep-1', state: 'otherPerson' }], 'b'),
      materials(done, [{ preparationId: 'prep-1', state: 'personUnknown' }], null),
      materials(required({ state: 'done', appliesTo: { kind: 'unknown' } }), [
        { preparationId: 'prep-1', state: 'appliesUnknown' },
      ]),
    ];
    for (const m of cases) {
      expect(preparationIssues(m)).toEqual([]);
      firstOption(m).needsPreparation = [];
      expect(preparationIssues(m)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'violation', code: 'preparation_mismatch' }),
        ]),
      );
    }
    expect(
      preparationIssues(
        materials(required({ state: 'done', appliesTo: { kind: 'household' } }), [], null),
      ),
    ).toEqual([]);
  });

  it('有効期限の最終日は使え、翌日は期限切れ', () => {
    expect(
      preparationIssues(materials(required({ state: 'done', validUntil: '2026-12-07' }), [])),
    ).toEqual([]);
    const m = materials(required({ state: 'done', validUntil: '2026-12-06' }), [
      { preparationId: 'prep-1', state: 'expired' },
    ]);
    expect(preparationIssues(m)).toEqual([]);
    firstGap(m).state = 'notDone';
    expect(preparationIssues(m).map((issue) => issue.code)).toContain('preparation_mismatch');
  });

  it('確認された暦日だけから求めた日を照らし、別の日や架空の期限を見逃さない', () => {
    const lead = {
      days: 3,
      from: 'useDate' as const,
      unit: 'calendarDays' as const,
      source: { kind: 'demo' as const },
      confirmedAt: '2026-11-30T10:00+09:00',
    };
    const m = materials(required({ lead }), [
      { preparationId: 'prep-1', state: 'unknown', by: '2026-12-04' },
    ]);
    expect(preparationIssues(m)).toEqual([]);
    firstGap(m).by = '2026-12-05';
    expect(preparationIssues(m).map((issue) => issue.code)).toContain('preparation_mismatch');
    const noLead = materials(required(), [
      { preparationId: 'prep-1', state: 'unknown', by: '2026-12-04' },
    ]);
    expect(preparationIssues(noLead).map((issue) => issue.code)).toContain('preparation_mismatch');
  });

  it('締切型の使う日を、事象の時刻を家庭の時区に直して求める', () => {
    const lead = {
      days: 3,
      from: 'useDate' as const,
      unit: 'calendarDays' as const,
      source: { kind: 'demo' as const },
      confirmedAt: '2026-11-30T10:00+09:00',
    };
    const m = materials(required({ lead }), [
      { preparationId: 'prep-1', state: 'unknown', by: '2026-12-04' },
    ]);
    m.events[2] = event(3, {
      type: 'itemsStated',
      sourceId: SOURCE,
      items: [
        {
          id: ITEM,
          sourceId: SOURCE,
          sentenceIds: [`${SOURCE}#1`],
          kind: 'need',
          written: 'その日までに頼む。',
          interpretation: {
            what: '頼む',
            shape: 'by',
            deadline: '2026-12-06T15:30+00:00',
            forMemberId: 'a',
          },
          evidence: 'stated',
          effects: [],
        },
      ],
    });
    expect(preparationIssues(m)).toEqual([]);
    firstGap(m).by = '2026-12-03';
    expect(preparationIssues(m).map((issue) => issue.code)).toContain('preparation_mismatch');
  });

  it('前提が複数なら全てを照らし、重複や無関係な印を拒む', () => {
    const m = materials();
    const way = m.family.ways[0];
    if (!way) throw new Error('やり方がない');
    way.requires = ['prep-1', 'prep-2'];
    m.family.preparations.push(required({ id: 'prep-2', state: 'inProgress' }));
    m.events[0] = event(1, { type: 'householdSet', household: m.family });
    gaps(m).push({ preparationId: 'prep-2', state: 'inProgress' });
    expect(preparationIssues(m)).toEqual([]);
    gaps(m).pop();
    expect(preparationIssues(m).map((issue) => issue.code)).toContain('preparation_mismatch');
    gaps(m).push({ preparationId: 'prep-1', state: 'unknown' });
    gaps(m).push({ preparationId: 'unrelated', state: 'unknown' });
    expect(preparationIssues(m).map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['preparation_duplicate', 'preparation_unexpected']),
    );
  });

  it('満たされない前提のある案は家族が選べるが、推薦はしない', () => {
    const m = materials();
    const selected = m.current.arrangements[0];
    if (!selected) throw new Error('手配がない');
    selected.chosenOptionKey = 'o';
    expect(preparationIssues(m)).toEqual([]);
    selected.recommendedOptionKey = 'o';
    expect(preparationIssues(m).map((issue) => issue.code)).toContain('preparation_recommended');
    firstOption(m).needsPreparation = [];
    expect(preparationIssues(m).map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['preparation_mismatch', 'preparation_recommended']),
    );
  });

  it('まだ選んでいない時、別の選べる案に未確認の前提があれば比較して推薦しない', () => {
    const m = materials();
    const selected = m.current.arrangements[0];
    const incomplete = firstOption(m);
    const way = m.family.ways[0];
    if (!selected || !way) throw new Error('手配かやり方がない');
    m.family.ways.push({
      ...way,
      id: 'other-way',
      name: '別の方法',
      requires: undefined,
    });
    m.events[0] = event(1, { type: 'householdSet', household: m.family });
    incomplete.decisionDeadline = '2026-12-06T10:00+09:00';
    selected.options.push({
      ...incomplete,
      key: 'other',
      templateId: 'other-way',
      decisionDeadline: '2026-12-06T10:00+09:00',
      needsPreparation: undefined,
    });
    selected.recommendedOptionKey = 'other';
    expect(preparationIssues(m).map((issue) => issue.code)).toContain(
      'preparation_comparison_unverified',
    );
    incomplete.expired = true;
    expect(preparationIssues(m).map((issue) => issue.code)).not.toContain(
      'preparation_comparison_unverified',
    );
  });

  it('使わない資源の印を照らし、その案の推薦を拒む（家族の選択は許す）', () => {
    const m = materials();
    useResource(m, 'notUsed');
    const arrangement = m.current.arrangements[0];
    if (!arrangement) throw new Error('手配がない');
    arrangement.chosenOptionKey = 'o';
    expect(preparationIssues(m)).toEqual([]);
    arrangement.recommendedOptionKey = 'o';
    expect(preparationIssues(m).map((issue) => issue.code)).toContain(
      'resource_not_used_recommended',
    );
    firstOption(m).unusedResources = [];
    expect(preparationIssues(m).map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['resource_use_mismatch', 'resource_not_used_recommended']),
    );
    firstOption(m).unusedResources = ['resource-1', 'resource-1'];
    expect(preparationIssues(m).map((issue) => issue.code)).toContain('resource_use_mismatch');
  });

  it('前提だけが別の資源を参照しても、やり方が使うとは決めつけない', () => {
    const m = materials();
    useResource(m, 'notUsed');
    const way = m.family.ways[0];
    const preparation = m.family.preparations[0];
    if (!way || !preparation) throw new Error('やり方か前提がない');
    way.resourceIds = undefined;
    preparation.resourceId = 'resource-1';
    firstOption(m).unusedResources = undefined;
    m.events[0] = event(1, { type: 'householdSet', household: m.family });
    expect(preparationIssues(m)).toEqual([]);
    firstOption(m).unusedResources = ['resource-1'];
    expect(preparationIssues(m).map((issue) => issue.code)).toContain('resource_use_mismatch');
  });

  it('使わない資源の案を比較から除き、残る案の推薦を誤って止めない', () => {
    const m = materials();
    useResource(m, 'notUsed');
    const arrangement = m.current.arrangements[0];
    const way = m.family.ways[0];
    const incomplete = firstOption(m);
    if (!arrangement || !way) throw new Error('手配かやり方がない');
    m.family.ways.push({
      ...way,
      id: 'other-way',
      name: '別の方法',
      requires: undefined,
      resourceIds: undefined,
    });
    m.events[0] = event(1, { type: 'householdSet', household: m.family });
    incomplete.decisionDeadline = '2026-12-06T10:00+09:00';
    arrangement.options.push({
      ...incomplete,
      key: 'other',
      templateId: 'other-way',
      needsPreparation: undefined,
      unusedResources: undefined,
    });
    arrangement.recommendedOptionKey = 'other';
    expect(preparationIssues(m)).toEqual([]);
    // 計画が印を隠しても、家庭から再確認して比較に戻さない。印の欠落は別に検出する。
    incomplete.unusedResources = undefined;
    const codes = preparationIssues(m).map((issue) => issue.code);
    expect(codes).toContain('resource_use_mismatch');
    expect(codes).not.toContain('preparation_comparison_unverified');
  });

  it('前提のない資源の印も、事項の履歴と独立に照らす', () => {
    const m = materials();
    useResource(m, 'notUsed');
    const way = m.family.ways[0];
    if (!way) throw new Error('やり方がない');
    way.requires = undefined;
    firstOption(m).needsPreparation = undefined;
    m.events.pop();
    firstOption(m).unusedResources = undefined;
    expect(preparationIssues(m).map((issue) => issue.code)).toContain('resource_use_mismatch');
    expect(preparationIssues(m).map((issue) => issue.code)).not.toContain('preparation_unverified');
  });

  it('事項の事象が欠けていたら、計画の日時だけで適用を確定しない', () => {
    const m = materials();
    m.events.pop();
    const issues = preparationIssues(m);
    expect(issues).toContainEqual(
      expect.objectContaining({ kind: 'undetermined', code: 'preparation_unverified' }),
    );
    expect(issues.some((issue) => issue.code === 'preparation_mismatch')).toBe(false);
  });
});
