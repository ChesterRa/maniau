// お知らせから読んだ「すること」（モデルが読んだ need）は、家族が確かめるまで計画に入れない。確かめ・直し・外しは、
// その時に採っていた読み取りに結び、読み直しの後には当てない。確かめる前の作用（置き換え・取り消し）は、効くか
// 分からない物として扱う（先の事項を「しだい」にし、黙って効かせも捨てもしない）。読み取りは手で書いた形。
import { describe, expect, it } from 'vitest';
import {
  conditionView,
  type Extraction,
  type Item,
  type Source,
  splitSentences,
  todayCards,
} from '../src';
import { computePlan, foldEvents, itemShown } from '../src/engine';
import { noticeArrived } from './fixtures/demo';

const TEXT =
  '12月12日（土）13:00〜14:00に地域交流会を行います。各家庭から大人1名、ご参加ください。';
const CHANGE = '地域交流会は14:00〜15:00に変更します。各家庭から大人1名、ご参加ください。';

const source = (id: string, text: string, at: string): Source => ({
  id,
  version: 1,
  receivedAt: at,
  sender: 'school',
  language: 'ja',
  medium: 'text',
  sentences: splitSentences(text, id),
});

const need = (sourceId: string, over: Partial<Item> = {}, endTime = '14:00'): Item => ({
  id: `${sourceId}:i1`,
  sourceId,
  sentenceIds: [`${sourceId}#1`],
  kind: 'need',
  written: '各家庭から大人1名、ご参加ください。',
  interpretation: {
    date: '2026-12-12',
    startTime: '13:00',
    endTime,
    what: '地域交流会への参加',
    shape: 'window',
  },
  evidence: 'stated',
  effects: [],
  ...over,
});

const reading = (sourceId: string, item: Item) => ({
  call: 'extract' as const,
  model: 'hand-written',
  promptVersion: 'fixture',
  inputHash: `fixture-${sourceId}-${item.interpretation.endTime}`,
  sourceId,
  output: {
    sourceId,
    items: [item],
    unknowns: [],
    conditions: [],
    irrelevantSentenceIds: [],
    ambiguities: [],
  } satisfies Extraction,
});

const AT = '2026-11-25T20:00+09:00';
const NOW = '2026-11-25T21:00+09:00';
const ID = 'n9:i1';

/** 交流会のお知らせを読んだ所まで（まだ確かめていない）。 */
const arrived = (item: Item = need('n9')) =>
  noticeArrived()
    .add('noticeReceived', AT, 'b', { source: source('n9', TEXT, AT) })
    .add('modelOutputRecorded', AT, 'system', reading('n9', item));

const requirementOf = (plan: ReturnType<typeof computePlan>, itemId: string) =>
  plan.requirements.find((r) => r.kind === 'need' && r.basis.itemIds.includes(itemId));
const arrangementOf = (plan: ReturnType<typeof computePlan>, itemId: string) => {
  const key = requirementOf(plan, itemId)?.key;
  return plan.arrangements.find((a) => a.kind === 'need' && a.requirementKey === key);
};

describe('お知らせから読んだ「すること」の確かめ', () => {
  it('確かめるまでは、日も時間も手配も作業も作らず、二人の「きょう」に確かめる札を出す', () => {
    const plan = computePlan(arrived().events, NOW);
    const requirement = requirementOf(plan, ID);
    expect(requirement).toMatchObject({
      live: true,
      unconfirmed: true,
      what: '地域交流会への参加',
    });
    expect(requirement).not.toHaveProperty('by');
    expect(arrangementOf(plan, ID)).toBeUndefined();
    expect(plan.tasks.filter((t) => t.basis.itemIds.includes(ID))).toEqual([]);
    for (const member of ['a', 'b']) {
      const cards = todayCards(plan, member).main.filter((c) => c.kind === 'needCheck');
      expect(cards.map((c) => (c.kind === 'needCheck' ? c.requirement.key : ''))).toEqual([
        requirement?.key,
      ]);
    }
  });

  it('「合っている」で計画に入り、札が消える。同じ事項 ID の読み直しの後は、また確かめてもらう', () => {
    const confirmed = arrived().add('itemConfirmed', NOW, 'b', { itemId: ID });
    const plan = computePlan(confirmed.events, NOW);
    expect(requirementOf(plan, ID)).not.toHaveProperty('unconfirmed');
    expect(arrangementOf(plan, ID)).toMatchObject({
      start: '2026-12-12T13:00+09:00',
      end: '2026-12-12T14:00+09:00',
    });
    expect(todayCards(plan, 'a').main.some((c) => c.kind === 'needCheck')).toBe(false);
    // 読み直し（同じ ID で、中身が替わった）。前の「合っている」は、前の読み取りへの物。
    const reread = confirmed.add(
      'modelOutputRecorded',
      NOW,
      'system',
      reading('n9', need('n9', {}, '15:00')),
    );
    const again = computePlan(reread.events, NOW);
    expect(requirementOf(again, ID)).toMatchObject({ unconfirmed: true });
    expect(arrangementOf(again, ID)).toBeUndefined();
  });

  it('直した中身はその読み取りにだけ当て、読み直しの後は使わない（直しも確かめも、やり直してもらう）', () => {
    const corrected = arrived().add('itemCorrected', NOW, 'b', {
      itemId: ID,
      interpretation: { endTime: '15:00' },
    });
    const plan = computePlan(corrected.events, NOW);
    expect(requirementOf(plan, ID)).not.toHaveProperty('unconfirmed');
    expect(arrangementOf(plan, ID)?.end).toBe('2026-12-12T15:00+09:00');
    // 読み直した後は、前の直しを当てない。確かめ直すと、読み直した中身（14:00 まで）になる。
    const reread = corrected
      .add('modelOutputRecorded', NOW, 'system', reading('n9', need('n9')))
      .add('itemConfirmed', NOW, 'a', { itemId: ID });
    expect(arrangementOf(computePlan(reread.events, NOW), ID)?.end).toBe('2026-12-12T14:00+09:00');
  });

  it('「読み取りが違う」で外すと、要件にもしない。読み直したら、また確かめてもらう', () => {
    const dismissed = arrived().add('itemDismissed', NOW, 'b', { itemId: ID, reason: 'misread' });
    expect(requirementOf(computePlan(dismissed.events, NOW), ID)).toBeUndefined();
    const reread = dismissed.add(
      'modelOutputRecorded',
      NOW,
      'system',
      reading('n9', need('n9', {}, '15:00')),
    );
    expect(requirementOf(computePlan(reread.events, NOW), ID)).toMatchObject({ unconfirmed: true });
  });

  it('確かめる前の置き換えは、先の事項を「しだい」にする。外せば元に戻り、確かめれば置き換える', () => {
    const LATER = '2026-11-26T20:00+09:00';
    const changed = () =>
      arrived()
        .add('itemConfirmed', NOW, 'b', { itemId: ID })
        .add('noticeReceived', LATER, 'b', { source: source('n10', CHANGE, LATER) })
        .add(
          'modelOutputRecorded',
          LATER,
          'system',
          reading(
            'n10',
            need(
              'n10',
              {
                written: CHANGE,
                interpretation: {
                  date: '2026-12-12',
                  startTime: '14:00',
                  endTime: '15:00',
                  what: '地域交流会への参加',
                  shape: 'window',
                },
                effects: [{ type: 'replace', itemId: ID }],
              },
              '15:00',
            ),
          ),
        );
    const pending = computePlan(changed().events, LATER);
    // 置き換えるかもしれない：前の手配は「しだい」になり、新しい物は確かめるまで計画に入らない。
    expect(requirementOf(pending, ID)).toMatchObject({ live: true, conditional: true });
    expect(requirementOf(pending, 'n10:i1')).toMatchObject({ unconfirmed: true });
    expect(arrangementOf(pending, 'n10:i1')).toBeUndefined();
    // 外す：前の物は確かな物に戻る。
    const dismissed = computePlan(
      changed().add('itemDismissed', LATER, 'b', { itemId: 'n10:i1', reason: 'misread' }).events,
      LATER,
    );
    expect(requirementOf(dismissed, ID)?.conditional).not.toBe(true);
    expect(requirementOf(dismissed, 'n10:i1')).toBeUndefined();
    // 確かめる：前の物は置き換わり、新しい物が計画に入る。
    const confirmed = computePlan(
      changed().add('itemConfirmed', LATER, 'b', { itemId: 'n10:i1' }).events,
      LATER,
    );
    expect(requirementOf(confirmed, ID)?.live ?? false).toBe(false);
    expect(arrangementOf(confirmed, 'n10:i1')).toMatchObject({
      start: '2026-12-12T14:00+09:00',
      end: '2026-12-12T15:00+09:00',
    });
  });

  it('元の文と食い違う・推定の読み取りも、確かめを待つ要件と札にする（作用は効かせない）。直せば計画に入る', () => {
    for (const evidence of ['conflicting', 'inferred'] as const) {
      const log = arrived(need('n9', { evidence }));
      const plan = computePlan(log.events, NOW);
      expect(requirementOf(plan, ID)).toMatchObject({ live: true, unconfirmed: true });
      expect(arrangementOf(plan, ID)).toBeUndefined();
      expect(todayCards(plan, 'a').main.some((c) => c.kind === 'needCheck')).toBe(true);
      const fixed = log.add('itemCorrected', NOW, 'b', {
        itemId: ID,
        interpretation: { endTime: '15:00' },
      });
      expect(arrangementOf(computePlan(fixed.events, NOW), ID)?.end).toBe('2026-12-12T15:00+09:00');
    }
  });

  it('読み取りの日時が過ぎても、確かめるまで要件と札を残す（確かめていない日時で、要らないとは決めない）', () => {
    const plan = computePlan(arrived().events, '2026-12-12T14:30+09:00');
    expect(requirementOf(plan, ID)).toMatchObject({ unconfirmed: true });
    expect(arrangementOf(plan, ID)).toBeUndefined();
    expect(todayCards(plan, 'a').main.some((c) => c.kind === 'needCheck')).toBe(true);
    // 外せば消える（家族の判断）。
    const dismissed = arrived().add('itemDismissed', NOW, 'b', { itemId: ID, reason: 'notOurs' });
    const after = computePlan(dismissed.events, '2026-12-12T14:30+09:00');
    expect(requirementOf(after, ID)).toBeUndefined();
    expect(todayCards(after, 'a').main.some((c) => c.kind === 'needCheck')).toBe(false);
  });

  it('確かめる時に見せる条件は、連結と否定のまま組む。値の名前や節点が無ければ、見せられないとする', () => {
    const nodes = new Map([
      ['c1', { id: 'c1', kind: 'and' as const, childIds: ['c2', 'c3'] }],
      ['c2', { id: 'c2', kind: 'eq' as const, unknownId: 'u1', value: 'yes' }],
      ['c3', { id: 'c3', kind: 'not' as const, childId: 'c4' }],
      ['c4', { id: 'c4', kind: 'eq' as const, unknownId: 'u2', value: 'no' }],
    ]);
    const labels = new Map([
      ['u1', { label: '行事が開催されるか' }],
      ['u2', { label: '参加を希望するか', from: { day: '2026-11-20' } }],
    ]);
    expect(conditionView('c1', nodes, labels)).toEqual({
      kind: 'and',
      children: [
        { kind: 'eq', label: '行事が開催されるか', value: 'yes' },
        {
          kind: 'not',
          child: {
            kind: 'eq',
            label: '参加を希望するか',
            value: 'no',
            from: { day: '2026-11-20' },
          },
        },
      ],
    });
    expect(
      conditionView('c1', nodes, new Map([['u1', { label: '行事が開催されるか' }]])),
    ).toBeUndefined();
    expect(conditionView('c9', nodes, labels)).toBeUndefined();
    // 事項：条件と、未定の値への答え（名前つき）。名前の無い値への答えがあれば、見せられない。
    const withEffects = (effects: Item['effects']) =>
      need('n9', {
        conditionNodeId: 'n9:c1',
        effects,
      });
    const log = (item: Item) =>
      noticeArrived()
        .add('noticeReceived', AT, 'b', { source: source('n9', TEXT, AT) })
        .add('modelOutputRecorded', AT, 'system', {
          ...reading('n9', item),
          output: {
            ...reading('n9', item).output,
            unknowns: [
              { id: 'n9:u1', label: '参加を希望するか', values: ['yes', 'no'], kind: 'family' },
            ],
            conditions: [{ id: 'n9:c1', kind: 'eq', unknownId: 'n9:u1', value: 'yes' }],
          },
        });
    const shown = withEffects([{ type: 'resolveUnknown', unknownId: 'n9:u1', value: 'yes' }]);
    expect(itemShown(foldEvents(log(shown).events), shown)).toEqual({
      shown: true,
      condition: { kind: 'eq', label: '参加を希望するか', value: 'yes' },
      answers: [{ unknownId: 'n9:u1', label: '参加を希望するか', value: 'yes' }],
      targets: [],
    });
    const unnamed = withEffects([{ type: 'resolveUnknown', unknownId: 'n9:u9', value: 'yes' }]);
    expect(itemShown(foldEvents(log(unnamed).events), unnamed).shown).toBe(false);
  });
});

describe('確かめが拠る読み取りと、見せる物の見分け', () => {
  const declare = (sourceId: string, label: string, hash = label) => ({
    call: 'extract' as const,
    model: 'hand-written',
    promptVersion: 'fixture',
    inputHash: `fixture-${sourceId}-${hash}`,
    sourceId,
    output: {
      sourceId,
      items: [],
      unknowns: [{ id: `${sourceId}:u1`, label, values: ['yes', 'no'], kind: 'schedule' as const }],
      conditions: [],
      irrelevantSentenceIds: [],
      ambiguities: [],
    } satisfies Extraction,
  });
  const event = (id: string, date: string): Item => ({
    id,
    sourceId: 'p1',
    sentenceIds: ['p1#1'],
    kind: 'event',
    written: '練習会',
    interpretation: { what: '練習会', date },
    evidence: 'stated',
    effects: [],
  });
  const events = (dates: string[]) => ({
    ...reading('p1', event('p1:i1', dates[0] ?? '')),
    output: {
      ...reading('p1', event('p1:i1', dates[0] ?? '')).output,
      items: dates.map((date, n) => event(`p1:i${n + 1}`, date)),
    },
  });
  const requirement = (log: { events: Parameters<typeof computePlan>[0] }) =>
    requirementOf(computePlan(log.events, NOW), ID);

  /** q1 の問いを条件に使う n9 の「すること」を確かめた所まで（q2 は関係の無いお知らせ）。 */
  const confirmedWithCondition = () => {
    const item = need('n9', { conditionNodeId: 'n9:c1' });
    return noticeArrived()
      .add('noticeReceived', AT, 'b', {
        source: source('q1', '交流会についてお知らせします。', AT),
      })
      .add('modelOutputRecorded', AT, 'system', declare('q1', '交流会が開かれるか'))
      .add('noticeReceived', AT, 'b', { source: source('q2', '雨の日のお知らせです。', AT) })
      .add('modelOutputRecorded', AT, 'system', declare('q2', '雨か'))
      .add('noticeReceived', AT, 'b', { source: source('n9', TEXT, AT) })
      .add('modelOutputRecorded', AT, 'system', {
        ...reading('n9', item),
        output: {
          ...reading('n9', item).output,
          conditions: [{ id: 'n9:c1', kind: 'eq' as const, unknownId: 'q1:u1', value: 'yes' }],
        },
      })
      .add('itemConfirmed', NOW, 'b', { itemId: ID });
  };

  it('条件の問いを持つ別のお知らせを読み直せば（同じ中身でも、替えて戻しても）、確かめをやり直す', () => {
    expect(requirement(confirmedWithCondition())).toBeDefined();
    expect(requirement(confirmedWithCondition())?.unconfirmed).toBeUndefined();
    // 関係の無いお知らせの読み直しでは、やり直さない。
    const unrelated = confirmedWithCondition().add(
      'modelOutputRecorded',
      NOW,
      'system',
      declare('q2', '雨か', 'again'),
    );
    expect(requirement(unrelated)?.unconfirmed).toBeUndefined();
    const same = confirmedWithCondition().add(
      'modelOutputRecorded',
      NOW,
      'system',
      declare('q1', '交流会が開かれるか', 'again'),
    );
    expect(requirement(same)).toMatchObject({ unconfirmed: true });
    const back = confirmedWithCondition()
      .add('modelOutputRecorded', NOW, 'system', declare('q1', '参加を希望するか'))
      .add('modelOutputRecorded', NOW, 'system', declare('q1', '交流会が開かれるか', 'back'));
    expect(requirement(back)).toMatchObject({ unconfirmed: true });
    // 確かめ直せば、また入る。
    expect(requirement(back.add('itemConfirmed', NOW, 'b', { itemId: ID }))?.unconfirmed).toBe(
      undefined,
    );
  });

  it('置き換え・取り消しの先は、何を・いつ・どのお知らせのかを見せ、同じ見え方の別の事項があれば確かめられない', () => {
    const item = need('n9', { effects: [{ type: 'cancel', itemId: 'p1:i1' }] });
    const log = (dates: string[]) =>
      noticeArrived()
        .add('noticeReceived', AT, 'b', {
          source: {
            ...source('p1', '練習会のお知らせです。', '2026-11-20T18:00+09:00'),
            title: '練習会だより',
          },
        })
        .add('modelOutputRecorded', AT, 'system', events(dates))
        .add('noticeReceived', AT, 'b', { source: source('n9', TEXT, AT) })
        .add('modelOutputRecorded', AT, 'system', reading('n9', item));
    expect(itemShown(foldEvents(log(['2026-12-05', '2026-12-12']).events), item)).toMatchObject({
      shown: true,
      targets: [
        {
          type: 'cancel',
          itemId: 'p1:i1',
          what: '練習会',
          when: { date: '2026-12-05' },
          from: { title: '練習会だより', day: '2026-11-20' },
        },
      ],
    });
    expect(itemShown(foldEvents(log(['2026-12-05', '2026-12-05']).events), item).shown).toBe(false);
  });

  it('同じ名前の別々の問いは、お知らせで見分ける。見分けられなければ確かめられない', () => {
    const answer = need('n9', {
      effects: [{ type: 'resolveUnknown', unknownId: 'q1:u1', value: 'yes' }],
    });
    const log = (secondAt: string, title?: string) =>
      noticeArrived()
        .add('noticeReceived', AT, 'b', {
          source: source('q1', '交流会についてお知らせします。', '2026-11-20T18:00+09:00'),
        })
        .add('modelOutputRecorded', AT, 'system', declare('q1', '参加するか'))
        .add('noticeReceived', AT, 'b', {
          source: {
            ...source('q2', '運動会についてお知らせします。', secondAt),
            ...(title ? { title } : {}),
          },
        })
        .add('modelOutputRecorded', AT, 'system', declare('q2', '参加するか'))
        .add('noticeReceived', AT, 'b', { source: source('n9', TEXT, AT) })
        .add('modelOutputRecorded', AT, 'system', reading('n9', answer));
    expect(itemShown(foldEvents(log('2026-11-22T18:00+09:00').events), answer)).toMatchObject({
      shown: true,
      answers: [
        { unknownId: 'q1:u1', label: '参加するか', value: 'yes', from: { day: '2026-11-20' } },
      ],
    });
    // 同じ日に届いた、題の無いお知らせ同士は見分けられない。題があれば見分けられる。
    expect(itemShown(foldEvents(log('2026-11-20T19:00+09:00').events), answer).shown).toBe(false);
    expect(
      itemShown(foldEvents(log('2026-11-20T19:00+09:00', '運動会だより').events), answer).shown,
    ).toBe(true);
  });

  it('見つからない先への作用は今は何もしない。後でその先が読まれたら、確かめをやり直す', () => {
    const item = need('n9', { effects: [{ type: 'replace', itemId: 'p1:i1' }] });
    const confirmed = noticeArrived()
      .add('noticeReceived', AT, 'b', { source: source('n9', TEXT, AT) })
      .add('modelOutputRecorded', AT, 'system', reading('n9', item))
      .add('itemConfirmed', NOW, 'b', { itemId: ID });
    expect(itemShown(foldEvents(confirmed.events), item)).toMatchObject({
      shown: true,
      targets: [{ type: 'replace', itemId: 'p1:i1' }],
    });
    expect(requirement(confirmed)?.unconfirmed).toBeUndefined();
    confirmed
      .add('noticeReceived', NOW, 'b', { source: source('p1', '練習会のお知らせです。', NOW) })
      .add('modelOutputRecorded', NOW, 'system', events(['2026-12-05']));
    expect(requirement(confirmed)).toMatchObject({ unconfirmed: true });
  });
});
