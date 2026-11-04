// 家族が地図で選んだ店（品物の名前を goods に持つ店）で買い物を置く試験。小さな対応表に無い品物も、選んだ店が
// あれば置け、道のりが分からなければ置けないと言わずに、まだ判断できないと「きょう」に出す。
// 地図の応答は手で作った架空の物で、Google の本物の応答は使わない。
import { describe, expect, it } from 'vitest';
import {
  type Extraction,
  Household,
  type MapInputs,
  type Source,
  splitSentences,
  todayCards,
} from '../src';
import { computePlan, purchaseGoods } from '../src/engine';
import { household, noticeArrived } from './fixtures/demo';

const TEXT = '12月5日(土)は、ハンカチを持ってきてください。';
const notice7: Source = {
  id: 'n7',
  version: 1,
  receivedAt: '2026-11-25T20:00+09:00',
  sender: 'school',
  language: 'ja',
  medium: 'text',
  title: '持ち物',
  sentences: splitSentences(TEXT, 'n7'),
};
const extraction7: Extraction = {
  sourceId: 'n7',
  unknowns: [],
  conditions: [],
  items: [
    {
      id: 'h1',
      sourceId: 'n7',
      sentenceIds: ['n7#1'],
      kind: 'belongings',
      written: TEXT,
      interpretation: { what: 'ハンカチ', date: '2026-12-05', writtenWeekday: 6 },
      evidence: 'stated',
      effects: [],
    },
  ],
  ambiguities: [],
  irrelevantSentenceIds: [],
};
const KEY = 'arr:purchase:h1';
const AT = '2026-11-25T20:30+09:00';

/** 豊洲駅に架空の place ID を付け、ハンカチを買う店として選んだ店を足した家庭。 */
const chosen = (goods: string[] = ['ハンカチ']) =>
  Household.parse({
    ...household,
    places: [
      ...household.places.map((p) =>
        p.id === 'st-toyosu' ? { ...p, googlePlaceId: 'g-station' } : p,
      ),
      {
        id: 'store-chosen',
        kind: 'store',
        name: '選んだ店',
        nearStationId: 'st-toyosu',
        googlePlaceId: 'g-chosen',
        lookedUpAt: '2026-11-25T20:20+09:00',
        goods,
      },
    ],
  });

const events = (h: Household) =>
  noticeArrived()
    .add('noticeReceived', '2026-11-25T20:00+09:00', 'b', { source: notice7 })
    .add('modelOutputRecorded', '2026-11-25T20:00+09:00', 'system', {
      call: 'extract',
      model: 'hand-written',
      promptVersion: 'fixture',
      inputHash: 'fixture-n7',
      sourceId: 'n7',
      output: extraction7,
    })
    .add('answered', '2026-11-25T20:10+09:00', 'b', {
      unknownId: 'u-atHome:h1',
      value: 'no',
      about: 'ハンカチ',
    })
    .add('householdSet', '2026-11-25T20:20+09:00', 'a', { household: h }).events;

const evidence: MapInputs = {
  checkedAt: '2026-11-25T20:25+09:00',
  stores: [
    {
      storeId: 'store-chosen',
      googlePlaceId: 'g-chosen',
      stationId: 'st-toyosu',
      stationGooglePlaceId: 'g-station',
      walkFromStationMin: 4,
      walkToStationMin: 5,
      regular: {
        timeZone: 'Asia/Tokyo',
        periods: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          open: '10:00',
          close: '21:00',
        })),
      },
    },
  ],
};

describe('家族が地図で選んだ店', () => {
  it('品物の名前で選んだ店があれば、対応表の種類より先に、その店で探す', () => {
    expect(purchaseGoods(household, 'ハンカチ')).toBeUndefined();
    expect(purchaseGoods(chosen(), 'ハンカチ')).toBe('ハンカチ');
    expect(purchaseGoods(household, '白い長袖シャツ')).toBe('kidsClothing');
    expect(purchaseGoods(chosen(['白い長袖シャツ']), '白い長袖シャツ')).toBe('白い長袖シャツ');
  });

  it('選んだ店の地図の根拠があれば、対応表に無い品物も、その店に地図の道のりで置く', () => {
    const plan = computePlan(events(chosen()), AT, evidence);
    expect(plan.arrangements.find((a) => a.key === KEY)?.status).toBe('decidable');
    expect(plan.tasks.find((t) => t.basis.arrangementKey === KEY)).toMatchObject({
      atPlaceId: 'store-chosen',
      travelSource: 'maps',
      travelBeforeMin: 4,
      travelAfterMin: 5,
      hoursBasis: 'mapsRegular',
    });
    expect(
      todayCards(plan, 'b').main.some((c) => c.kind === 'stuck' && c.arrangement.key === KEY),
    ).toBe(false);
  });

  it('道のりが地図にも家庭の目安にも無ければ、置けないと言わず、まだ判断できないと二人の「きょう」に出す', () => {
    const plan = computePlan(events(chosen()), AT);
    const arrangement = plan.arrangements.find((a) => a.key === KEY);
    expect(arrangement?.status).toBe('undetermined');
    expect(arrangement?.reasons).toContainEqual({ code: 'inputMissing', refs: ['storeHours'] });
    expect(arrangement?.reasons.some((r) => r.code === 'noOptionLeft')).toBe(false);
    for (const member of ['a', 'b']) {
      expect(
        todayCards(plan, member).main.filter(
          (c) => c.kind === 'stuck' && c.arrangement.key === KEY,
        ),
      ).toHaveLength(1);
    }
  });
});
