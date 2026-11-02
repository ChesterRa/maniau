// だれも持っていない作業：二人の「きょう」に出し続け、期限が近づいた時だけ、二人に一度知らせる。
import { describe, expect, it } from 'vitest';
import {
  type Extraction,
  notificationHistory,
  notificationIntents,
  type Source,
  splitSentences,
} from '../src';
import { computePlan } from '../src/engine';
import { household, noticeArrived } from './fixtures/demo';

const TEXT = '個人面談の出欠票を、11月27日(金)までに担任に提出してください。';
const notice3: Source = {
  id: 'n3',
  version: 1,
  receivedAt: '2026-11-25T20:00+09:00',
  sender: 'school',
  language: 'ja',
  medium: 'text',
  title: '個人面談',
  sentences: splitSentences(TEXT, 'n3'),
};
const extraction3: Extraction = {
  sourceId: 'n3',
  unknowns: [],
  conditions: [],
  items: [
    {
      id: 's1',
      sourceId: 'n3',
      sentenceIds: ['n3#1'],
      kind: 'submission',
      written: TEXT,
      interpretation: { what: '個人面談の出欠票', date: '2026-11-27', writtenWeekday: 5 },
      evidence: 'stated',
      effects: [],
    },
  ],
  ambiguities: [],
  irrelevantSentenceIds: [],
};
const TASK = 'task:submit:s1';
const withNotice = () =>
  noticeArrived()
    .add('noticeReceived', '2026-11-25T20:00+09:00', 'b', { source: notice3 })
    .add('modelOutputRecorded', '2026-11-25T20:00+09:00', 'system', {
      call: 'extract',
      model: 'hand-written',
      promptVersion: 'fixture',
      inputHash: 'fixture-n3',
      sourceId: 'n3',
      output: extraction3,
    });

const unownedAt = (events: Parameters<typeof computePlan>[0], now: string) =>
  notificationIntents(computePlan(events, now), household, notificationHistory(events)).filter(
    (i) => i.titleKey === 'notify.unowned',
  );

describe('だれも持っていない作業の知らせ', () => {
  it('届いた時は知らせない（画面で足りる）', () => {
    expect(unownedAt(withNotice().events, '2026-11-25T20:05+09:00')).toEqual([]);
  });

  it('締切の前の晩からは、二人に一度ずつ知らせる（締切を過ぎたら送らない）', () => {
    const intents = unownedAt(withNotice().events, '2026-11-26T07:00+09:00');
    expect(intents.map((i) => i.toMemberId).sort()).toEqual(['a', 'b']);
    for (const intent of intents) {
      expect(intent).toMatchObject({
        key: `unowned:${TASK}:${intent.toMemberId}`,
        subject: { type: 'task', id: TASK },
        kind: 'assignment',
        until: '2026-11-27T08:00+09:00',
      });
    }
    expect(unownedAt(withNotice().events, '2026-11-27T08:30+09:00')).toEqual([]);
  });

  it('だれかが持てば、もう知らせない', () => {
    const events = withNotice().add('assignmentProposed', '2026-11-26T06:50+09:00', 'b', {
      taskKey: TASK,
      assigneeId: 'b',
    }).events;
    expect(unownedAt(events, '2026-11-26T07:00+09:00')).toEqual([]);
  });
});
