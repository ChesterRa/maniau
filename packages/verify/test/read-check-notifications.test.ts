// 読み取り確認の知らせを、計画の reading 欄ではなく事象から照らす。
import { describe, expect, it } from 'vitest';
import { verifyNotificationMessage, verifyNotifications } from '../src';
import { event, household, plan, requirement } from './fixtures';

const source = {
  id: 'n9',
  version: 1,
  receivedAt: '2026-11-30T09:00+09:00',
  sender: 'school',
  language: 'ja',
  sentences: [{ id: 'n9#1', text: '12月7日までに申し込みます。' }],
};
const item = {
  id: 'n9:i1',
  sourceId: 'n9',
  sentenceIds: ['n9#1'],
  kind: 'need',
  written: '12月7日までに申し込みます。',
  interpretation: { what: '申し込み', shape: 'by', deadline: '2026-12-07T08:00+09:00' },
  evidence: 'stated',
  effects: [],
};
const reading = (seq: number, extras: Record<string, unknown> = {}) =>
  event(seq, {
    type: 'modelOutputRecorded',
    call: 'extract',
    actorId: 'system',
    sourceId: 'n9',
    sourceVersion: 1,
    model: 'fixture',
    promptVersion: 'fixture',
    inputHash: 'fixture',
    output: {
      sourceId: 'n9',
      items: [item],
      unknowns: [],
      conditions: [],
      irrelevantSentenceIds: [],
      ambiguities: [],
    },
    ...extras,
  });
const base = () => [
  event(1, { type: 'householdSet', household: household() }),
  event(2, { type: 'noticeReceived', actorId: 'b', source }),
  reading(3),
];
const intent = {
  key: 'readCheck:n9:3:b',
  toMemberId: 'b',
  kind: 'question',
  titleKey: 'notify.readCheck',
  subject: { type: 'reading', id: 'n9', seq: 3 },
};
const pending = () =>
  requirement({
    kind: 'need',
    what: '申し込み',
    basis: { itemIds: ['n9:i1'] },
    unconfirmed: true,
    // 意図の根拠としてこの欄を信用しないことも確かめる。
    reading: { sourceId: 'n9', seq: 3, at: '2026-11-30T09:00+09:00', addedBy: 'b' },
  });
const check = (
  events = base(),
  i: unknown = intent,
  now = '2026-11-30T11:00+09:00',
  requirements: unknown[] = [pending()],
) =>
  verifyNotifications({
    household: household(),
    plan: plan({ throughSeq: events.length, now, requirements }),
    events,
    intents: [i],
  });
const violations = (report: ReturnType<typeof check>) =>
  report.issues.filter((i) => i.kind === 'violation').map((i) => i.code);

describe('未確認の読み取りの知らせ', () => {
  it('採用された読み取りから一時間、追加した大人への内容の無い知らせを通す', () => {
    expect(violations(check())).toEqual([]);
    expect(violations(check(base(), intent, '2026-11-30T10:59+09:00'))).toContain(
      'notification_wrong_time',
    );
    expect(violations(check(base(), intent, '2026-11-30T11:00+09:00'))).toEqual([]);
    for (const [language, body] of [
      ['ja', 'お知らせの読み取りで、まだ確かめていないものがあります。'],
      ['en', "Part of a notice's reading hasn't been checked yet."],
    ] as const) {
      const result = verifyNotificationMessage({
        language,
        intents: [intent],
        message: {
          title: language === 'ja' ? 'まにあう' : 'Maniau',
          body,
          titleKey: 'notify.readCheck',
          count: 1,
        },
      });
      expect(result.issues.filter((entry) => entry.kind === 'violation')).toEqual([]);
    }
  });

  it('別の成員、system、偽のキー・時刻・内容を拒む', () => {
    expect(
      violations(check(base(), { ...intent, toMemberId: 'a', key: 'readCheck:n9:3:a' })),
    ).toContain('notification_subject_mismatch');
    const system = base();
    system[1] = event(2, { type: 'noticeReceived', actorId: 'system', source });
    expect(violations(check(system))).toContain('notification_subject_mismatch');
    const systemFamily = household();
    const adult = systemFamily.members.find((member) => member.id === 'a');
    if (!adult) throw new Error('成員がいない');
    adult.id = 'system';
    system[0] = event(1, { type: 'householdSet', household: systemFamily });
    const systemIntent = { ...intent, toMemberId: 'system', key: 'readCheck:n9:3:system' };
    const systemResult = verifyNotifications({
      household: systemFamily,
      plan: plan({ throughSeq: 3, now: '2026-11-30T11:00+09:00', requirements: [pending()] }),
      events: system,
      intents: [systemIntent],
    });
    expect(systemResult.issues.map((entry) => entry.code)).toContain(
      'notification_subject_mismatch',
    );
    expect(violations(check(base(), { ...intent, key: 'readCheck:n9:4:b' }))).toContain(
      'notification_key_mismatch',
    );
    expect(violations(check(base(), { ...intent, kind: 'assignment' }))).toContain(
      'notification_kind_mismatch',
    );
    expect(violations(check(base(), { ...intent, until: '2026-12-01T00:00+09:00' }))).toContain(
      'notification_deadline_mismatch',
    );
    expect(
      violations(check(base(), { ...intent, subject: { type: 'reading', id: 'n9', seq: 3.5 } })),
    ).toContain('notification_invalid');
    const wrong = verifyNotificationMessage({
      language: 'ja',
      intents: [intent],
      message: {
        title: 'まにあう',
        body: '個別の内容',
        titleKey: 'notify.readCheck',
        count: 1,
      },
    });
    expect(wrong.issues.map((i) => i.code)).toContain('notification_message_not_allowed');
  });

  it('家族が確認・訂正・排除した後と出典を取り下げた後は、古い札があっても拒む', () => {
    for (const body of [
      { type: 'itemConfirmed', itemId: 'n9:i1' },
      { type: 'itemCorrected', itemId: 'n9:i1', interpretation: { what: '申込' } },
      { type: 'itemDismissed', itemId: 'n9:i1', reason: 'misread' },
      { type: 'sourceWithdrawn', sourceId: 'n9' },
    ])
      expect(violations(check([...base(), event(4, body)]))).toContain(
        'notification_subject_mismatch',
      );
  });

  it('現在採用された読み取り以外と、言明を読み取りとして知らせない', () => {
    const reread = [...base(), reading(4, { occurredAt: '2026-11-30T10:30+09:00' })];
    expect(violations(check(reread))).toContain('notification_subject_mismatch');
    const next = {
      ...intent,
      key: 'readCheck:n9:4:b',
      subject: { type: 'reading', id: 'n9', seq: 4 },
    };
    expect(violations(check(reread, next))).toContain('notification_wrong_time');
    expect(violations(check(reread, next, '2026-11-30T11:30+09:00'))).toEqual([]);
    const stated = [
      event(1, { type: 'householdSet', household: household() }),
      event(2, { type: 'noticeReceived', actorId: 'b', source: { ...source, sender: 'family' } }),
      event(3, { type: 'itemsStated', sourceId: 'n9', items: [item] }),
    ];
    expect(violations(check(stated))).toContain('notification_subject_mismatch');
  });

  it('空の計画や偽の reading 欄だけでは、存在しない確認札を根拠にしない', () => {
    expect(violations(check(base(), intent, '2026-11-30T11:00+09:00', []))).toContain(
      'notification_subject_mismatch',
    );
    const mismatched = {
      ...pending(),
      reading: {
        sourceId: 'not-n9',
        seq: 99,
        at: '2026-11-30T09:00+09:00',
        addedBy: 'a',
      },
    };
    expect(violations(check(base(), intent, '2026-11-30T11:00+09:00', [mismatched]))).toEqual([]);
    const unrelated = {
      ...intent,
      key: 'readCheck:not-n9:3:b',
      subject: { type: 'reading', id: 'not-n9', seq: 3 },
    };
    expect(violations(check(base(), unrelated, '2026-11-30T11:00+09:00', [mismatched]))).toContain(
      'notification_subject_mismatch',
    );
  });
  it('読み取った条件が今は偽でも、その条件を確認する必要があれば知らせられる', () => {
    const withCondition = reading(3, {
      output: {
        sourceId: 'n9',
        items: [{ ...item, conditionNodeId: 'n9:c1' }],
        unknowns: [{ id: 'n9:u1', label: '利用するか', kind: 'family', values: ['yes', 'no'] }],
        conditions: [{ id: 'n9:c1', kind: 'eq', unknownId: 'n9:u1', value: 'yes' }],
        irrelevantSentenceIds: [],
        ambiguities: [],
      },
    });
    const events = [
      ...base().slice(0, 2),
      withCondition,
      event(4, { type: 'answered', unknownId: 'n9:u1', value: 'no' }),
    ];
    const inactiveCard = { ...pending(), live: false };
    expect(violations(check(events, intent, '2026-11-30T11:00+09:00', [inactiveCard]))).toEqual([]);
  });

  it('後に届いた古い版の読み取りは、採用した版の番号を置き換えない', () => {
    const events = [
      ...base(),
      event(4, {
        type: 'transcriptionCorrected',
        sourceId: 'n9',
        sourceVersion: 2,
        sentences: source.sentences,
      }),
      reading(5, { sourceVersion: 2 }),
      reading(6, { sourceVersion: 1 }),
    ];
    const current = {
      ...intent,
      key: 'readCheck:n9:5:b',
      subject: { type: 'reading', id: 'n9', seq: 5 },
    };
    expect(violations(check(events, current))).toEqual([]);
    const rejected = {
      ...intent,
      key: 'readCheck:n9:6:b',
      subject: { type: 'reading', id: 'n9', seq: 6 },
    };
    expect(violations(check(events, rejected))).toContain('notification_subject_mismatch');
  });

  it('参照先の出典の読み直しで確認が失効した時、元の読み取り番号から確かめ直す', () => {
    const other = {
      ...source,
      id: 'n8',
      sentences: [{ id: 'n8#1', text: '利用するかを決めてください。' }],
    };
    const otherReading = (seq: number) =>
      event(seq, {
        type: 'modelOutputRecorded',
        call: 'extract',
        actorId: 'system',
        sourceId: 'n8',
        sourceVersion: 1,
        model: 'fixture',
        promptVersion: 'fixture',
        inputHash: 'fixture',
        output: {
          sourceId: 'n8',
          items: [],
          unknowns: [{ id: 'n8:u1', label: '利用するか', kind: 'family', values: ['yes', 'no'] }],
          conditions: [],
          irrelevantSentenceIds: ['n8#1'],
          ambiguities: [],
        },
      });
    const events = [
      event(1, { type: 'householdSet', household: household() }),
      event(2, { type: 'noticeReceived', actorId: 'a', source: other }),
      otherReading(3),
      event(4, { type: 'noticeReceived', actorId: 'b', source }),
      reading(5, {
        output: {
          sourceId: 'n9',
          items: [{ ...item, conditionNodeId: 'n9:c1' }],
          unknowns: [],
          conditions: [{ id: 'n9:c1', kind: 'eq', unknownId: 'n8:u1', value: 'yes' }],
          irrelevantSentenceIds: [],
          ambiguities: [],
        },
      }),
      event(6, { type: 'itemConfirmed', itemId: 'n9:i1' }),
    ];
    const original = {
      ...intent,
      key: 'readCheck:n9:5:b',
      subject: { type: 'reading', id: 'n9', seq: 5 },
    };
    expect(violations(check(events, original))).toContain('notification_subject_mismatch');
    expect(violations(check([...events, otherReading(7)], original))).toEqual([]);
  });
});
