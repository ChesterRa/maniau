// お知らせから読んだ「すること」を、読み取りから 1 時間たっても確かめていなければ、お知らせを入れた大人にだけ、
// 中身の無い知らせを一度出す（同じ読み取りの事項はまとめる。読み取りの日時で急がない。夜は朝まで待つ。仕組みが
// 入れたお知らせには出さない）。確かめ・外し・読み直しで消える。読み取りは手で書いた形。
import { describe, expect, it } from 'vitest';
import {
  type DomainEvent,
  type Extraction,
  holdUntilMorning,
  type Item,
  notificationIntents,
  type Source,
  splitSentences,
  toEpochMinutes,
} from '../src';
import { computePlan } from '../src/engine';
import { household, noticeArrived } from './fixtures/demo';

const AT = '2026-11-25T20:00+09:00';
const TEXT =
  '12月12日（土）13:00〜14:00に地域交流会を行います。各家庭から大人1名、ご参加ください。';

const source = (id: string): Source => ({
  id,
  version: 1,
  receivedAt: AT,
  sender: 'school',
  language: 'ja',
  medium: 'text',
  sentences: splitSentences(TEXT, id),
});

const need = (n: number): Item => ({
  id: `n9:i${n}`,
  sourceId: 'n9',
  sentenceIds: ['n9#1'],
  kind: 'need',
  written: '各家庭から大人1名、ご参加ください。',
  interpretation: {
    date: '2026-12-12',
    startTime: '13:00',
    endTime: '14:00',
    what: `地域交流会への参加${n}`,
    shape: 'window',
  },
  evidence: 'stated',
  effects: [],
});

const reading = (hash: string) => ({
  call: 'extract' as const,
  model: 'hand-written',
  promptVersion: 'fixture',
  inputHash: `fixture-n9-${hash}`,
  sourceId: 'n9',
  output: {
    sourceId: 'n9',
    items: [need(1), need(2)],
    unknowns: [],
    conditions: [],
    irrelevantSentenceIds: [],
    ambiguities: [],
  } satisfies Extraction,
});

/** 大人 b（または仕組み）がお知らせを入れ、二つの「すること」を読んだ所まで。 */
const added = (by = 'b') =>
  noticeArrived()
    .add('noticeReceived', AT, by, { source: source('n9') })
    .add('modelOutputRecorded', AT, 'system', reading('first'));

const lastReadingSeq = (events: readonly DomainEvent[]) =>
  events.filter((e) => e.type === 'modelOutputRecorded' && e.sourceId === 'n9').at(-1)?.seq;

const readChecks = (events: readonly DomainEvent[], at: string) =>
  notificationIntents(computePlan(events, at), household).filter(
    (i) => i.titleKey === 'notify.readCheck',
  );

describe('確かめていない読み取りの知らせ', () => {
  it('読み取りから 1 時間たって確かめていなければ、お知らせを入れた大人にだけ一度（事項はまとめる）', () => {
    const log = added();
    expect(readChecks(log.events, '2026-11-25T20:59+09:00')).toEqual([]);
    const seq = lastReadingSeq(log.events);
    expect(readChecks(log.events, '2026-11-25T21:00+09:00')).toEqual([
      {
        key: `readCheck:n9:${seq}:b`,
        subject: { type: 'reading', id: 'n9', seq },
        toMemberId: 'b',
        kind: 'question',
        titleKey: 'notify.readCheck',
      },
    ]);
  });

  it('一つでも確かめていない事項があれば残り、全部を確かめるか外すと消える', () => {
    const log = added().add('itemConfirmed', '2026-11-25T20:30+09:00', 'a', { itemId: 'n9:i1' });
    expect(readChecks(log.events, '2026-11-25T21:00+09:00')).toHaveLength(1);
    log.add('itemDismissed', '2026-11-25T20:40+09:00', 'a', {
      itemId: 'n9:i2',
      reason: 'misread',
    });
    expect(readChecks(log.events, '2026-11-25T21:00+09:00')).toEqual([]);
  });

  it('読み直すと、新しい読み取りから数え直す（前の読み取りへの知らせは消える）', () => {
    const log = added().add('modelOutputRecorded', '2026-11-25T20:30+09:00', 'system', {
      ...reading('again'),
    });
    expect(readChecks(log.events, '2026-11-25T21:00+09:00')).toEqual([]);
    const seq = lastReadingSeq(log.events);
    expect(readChecks(log.events, '2026-11-25T21:30+09:00').map((i) => i.key)).toEqual([
      `readCheck:n9:${seq}:b`,
    ]);
  });

  it('仕組みが入れたお知らせには出さない（だれが入れたか分からない人に、届いたとは言えない）', () => {
    expect(readChecks(added('system').events, '2026-11-26T09:00+09:00')).toEqual([]);
  });

  it('期限を持たないので、夜は朝まで待つ', () => {
    const [intent] = readChecks(added().events, '2026-11-25T23:30+09:00');
    if (!intent) throw new Error('知らせが無い');
    expect(holdUntilMorning(intent, toEpochMinutes('2026-11-25T23:30+09:00'), 'Asia/Tokyo')).toBe(
      toEpochMinutes('2026-11-26T07:00+09:00'),
    );
  });
});
