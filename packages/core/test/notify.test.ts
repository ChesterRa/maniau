// 知らせの決まり：もう待てない物だけを、本人に、名前を入れずに知らせる。
import { describe, expect, it } from 'vitest';
import {
  type DomainEvent,
  holdUntilMorning,
  MORNING_SLACK_MIN,
  NOTIFICATION_TEXT,
  notificationHistory,
  notificationIntents,
  notificationMessage,
  proposalSnapshot,
  toEpochMinutes,
} from '../src';
import { computePlan, requestSnapshot } from '../src/engine';
import { extraction2, household, notice2, noticeArrived } from './fixtures/demo';

const CARE = 'arr:childCare:i4:c';
const opt = (template: string) => `opt:${CARE}:${template}`;
const ask = `task:${opt('opt-grandma')}:ask`;
const write = `task:${opt('opt-gakudo')}:write`;
const bento = `task:${opt('opt-gakudo')}:bento-shop`;

const intentsAt = (events: readonly DomainEvent[], at: string) =>
  notificationIntents(computePlan(events, at), household, notificationHistory(events));
const summary = (events: readonly DomainEvent[], at: string) =>
  intentsAt(events, at).map((i) => `${i.toMemberId}:${i.titleKey}`);

const asked = () =>
  noticeArrived()
    .add('answered', '2026-11-25T19:35+09:00', 'b', { unknownId: 'u-atHome:i3', value: 'no' })
    .add('optionChosen', '2026-11-25T19:36+09:00', 'b', {
      arrangementKey: CARE,
      optionKey: opt('opt-grandma'),
      role: 'primary',
    })
    .add('assignmentProposed', '2026-11-25T19:36+09:00', 'b', { taskKey: ask, assigneeId: 'b' })
    .add('commitmentChanged', '2026-11-25T19:37+09:00', 'b', {
      taskKey: ask,
      assigneeId: 'b',
      action: 'accept',
    })
    .add('externalRequestSent', '2026-11-25T19:40+09:00', 'b', {
      taskKey: ask,
      requestId: 'r-grandma',
    });

/** 祖母の返事を待つ間に、彩が学童を予備に押さえ、申込みの記入を健太に頼んだ。 */
const backupAskedOfKenta = () =>
  asked()
    .add('optionChosen', '2026-11-29T21:05+09:00', 'b', {
      arrangementKey: CARE,
      optionKey: opt('opt-gakudo'),
      role: 'backup',
    })
    .add('assignmentProposed', '2026-11-29T21:06+09:00', 'b', { taskKey: bento, assigneeId: 'a' })
    .add('assignmentProposed', '2026-11-29T21:06+09:00', 'b', { taskKey: write, assigneeId: 'a' });

const postponed = () =>
  asked()
    .add('noticeReceived', '2026-12-04T17:52+09:00', 'b', { source: notice2 })
    .add('modelOutputRecorded', '2026-12-04T17:52+09:00', 'system', {
      call: 'extract',
      model: 'hand-written',
      promptVersion: 'fixture',
      inputHash: 'fixture-n2',
      sourceId: 'n2',
      output: extraction2,
    });

describe('知らせの決まり', () => {
  it('届いた夜は、決め時も問いの期限も遠いので知らせない（画面で足りる）', () => {
    expect(intentsAt(noticeArrived().events, '2026-11-25T19:31+09:00')).toEqual([]);
  });

  it('まだ決めていなければ、最初に選べなくなる案の決め時の前の日から、二人の大人に知らせる', () => {
    const events = noticeArrived().events;
    // 学童の決め時（11/30 17:20）の26時間前より前は、まだ知らせない。
    expect(summary(events, '2026-11-29T15:19+09:00')).toEqual([]);
    const intents = intentsAt(events, '2026-11-29T16:00+09:00');
    expect(intents.map((i) => `${i.toMemberId}:${i.titleKey}`)).toEqual([
      'a:notify.decide',
      'b:notify.decide',
    ]);
    expect(intents.map((i) => i.until)).toEqual([
      '2026-11-30T17:20+09:00',
      '2026-11-30T17:20+09:00',
    ]);
    expect(new Set(intents.map((i) => i.key)).size).toBe(2);
    // 同じ計画なら、同じキー（送り直しても一つに数える）。
    expect(intentsAt(events, '2026-11-29T16:05+09:00').map((i) => i.key)).toEqual(
      intents.map((i) => i.key),
    );
  });

  it('答えで段取りが変わる問いは、聞く期限の前の日から、二人に', () => {
    const events = noticeArrived().events;
    // 期限（12/03 19:05）の26時間前は 12/02 17:05。
    expect(summary(events, '2026-12-02T17:00+09:00')).not.toContain('a:notify.question');
    expect(summary(events, '2026-12-02T18:00+09:00')).toEqual([
      'a:notify.question',
      'b:notify.question',
    ]);
  });

  it('大人が頼んだ物は、頼まれた本人にすぐ知らせる。自分で自分に頼んだ物は知らせない', () => {
    const events = backupAskedOfKenta().events;
    const intents = intentsAt(events, '2026-11-29T21:10+09:00');
    // 健太へ：彩が頼んだ記入と、それに続く提出（決め時が近い）。彩へは何も（祖母への依頼は自分で頼んだ）。
    expect(intents.map((i) => `${i.toMemberId}:${i.titleKey}`)).toEqual([
      'a:notify.proposal',
      'a:notify.proposal',
    ]);
    expect(intents.every((i) => i.kind === 'assignment')).toBe(true);
    // 健太が引き受けたら、その分の知らせは出さない。
    const plan = computePlan(events, '2026-11-29T21:20+09:00');
    const task = plan.tasks.find((t) => t.key === write);
    const shown = task && proposalSnapshot(task);
    if (!shown) throw new Error('記入が置けていない');
    const accepted = backupAskedOfKenta().add('commitmentChanged', '2026-11-29T21:20+09:00', 'a', {
      taskKey: write,
      assigneeId: 'a',
      action: 'accept',
      shown,
    });
    const left = intentsAt(accepted.events, '2026-11-29T21:25+09:00');
    expect(left).toHaveLength(1);
    expect(left[0]?.subject).not.toEqual({ type: 'task', id: write });
  });

  it('仕組みが勧める買い物は、日ごとに置き直すので、決め時が近い時だけ知らせる', () => {
    const events = asked().events;
    // 健太の帰りの買い物（決め時は 12/04）：札は出すが、知らせない。
    expect(summary(events, '2026-11-26T12:10+09:00')).toEqual([]);
  });

  it('仕組み（system）が書いた提案も、仕組みの勧めとして、決め時が近い時だけ知らせる', () => {
    const events = asked().add('assignmentProposed', '2026-11-26T12:00+09:00', 'system', {
      taskKey: 'task:opt:arr:purchase:i3:buy:buy',
      assigneeId: 'a',
    }).events;
    expect(summary(events, '2026-11-26T12:10+09:00')).toEqual([]);
    expect(summary(events, '2026-12-03T18:00+09:00')).toEqual(['a:notify.proposal']);
  });

  it('引き受けた後に中身が変わった物は、自分で頼んだ物でも知らせ直す', () => {
    // 健太が、学童の申込みの記入を自分で引き受ける。
    const base = asked()
      .add('optionChosen', '2026-11-29T21:05+09:00', 'b', {
        arrangementKey: CARE,
        optionKey: opt('opt-gakudo'),
        role: 'backup',
      })
      .add('assignmentProposed', '2026-11-29T21:06+09:00', 'a', {
        taskKey: write,
        assigneeId: 'a',
      });
    expect(
      intentsAt(base.events, '2026-11-29T21:07+09:00').map((i) => i.subject),
    ).not.toContainEqual({ type: 'task', id: write });
    const task = computePlan(base.events, '2026-11-29T21:07+09:00').tasks.find(
      (t) => t.key === write,
    );
    const shown = task && proposalSnapshot(task);
    if (!shown) throw new Error('記入が置けていない');
    // 引き受けた時に見た時刻と、今の計画の時刻が違う（中身が変わった）。
    const earlier = { ...shown, start: '2026-11-30T17:00+09:00', end: '2026-11-30T17:10+09:00' };
    const events = base.add('commitmentChanged', '2026-11-29T21:08+09:00', 'a', {
      taskKey: write,
      assigneeId: 'a',
      action: 'accept',
      shown: earlier,
    }).events;
    const changed = intentsAt(events, '2026-11-29T21:10+09:00').filter(
      (i) => i.subject.type === 'task' && i.subject.id === write,
    );
    expect(changed.map((i) => `${i.toMemberId}:${i.titleKey}`)).toEqual(['a:notify.changed']);
    expect(changed[0]?.key).toBe(`changed:${write}:a`);
  });

  it('要らなくなった頼み事は、頼んだ本人にすぐ知らせる', () => {
    const intents = intentsAt(postponed().events, '2026-12-04T18:10+09:00');
    expect(intents.map((i) => `${i.toMemberId}:${i.titleKey}:${i.kind}`)).toEqual([
      'b:notify.cancel:cancellation',
    ]);
    expect(intents[0]?.key).toBe('cancel:r-grandma:b');
  });

  it('期間のある依頼の取り消しは、期間の終わりまで伝える。夜に待つかは、期間の始まりで決める', () => {
    const base = noticeArrived()
      .add('answered', '2026-11-25T19:35+09:00', 'b', { unknownId: 'u-atHome:i3', value: 'no' })
      .add('optionChosen', '2026-11-25T19:36+09:00', 'b', {
        arrangementKey: CARE,
        optionKey: opt('opt-grandma'),
        role: 'primary',
      })
      .add('assignmentProposed', '2026-11-25T19:36+09:00', 'b', { taskKey: ask, assigneeId: 'b' })
      .add('commitmentChanged', '2026-11-25T19:37+09:00', 'b', {
        taskKey: ask,
        assigneeId: 'b',
        action: 'accept',
      });
    const snapshot = requestSnapshot(base.events, '2026-11-25T19:40+09:00', ask);
    expect(snapshot.window).toBeDefined();
    const events = base
      .add('externalRequestSent', '2026-11-25T19:40+09:00', 'b', {
        taskKey: ask,
        requestId: 'r-grandma',
        snapshot,
      })
      .add('noticeReceived', '2026-12-04T17:52+09:00', 'b', { source: notice2 })
      .add('modelOutputRecorded', '2026-12-04T17:52+09:00', 'system', {
        call: 'extract',
        model: 'hand-written',
        promptVersion: 'fixture',
        inputHash: 'fixture-n2',
        sourceId: 'n2',
        output: extraction2,
      }).events;
    const [cancel] = intentsAt(events, '2026-12-04T18:10+09:00');
    expect(cancel).toMatchObject({
      key: 'cancel:r-grandma:b',
      subject: { type: 'request', id: 'r-grandma' },
      until: snapshot.window?.end,
      actBy: snapshot.window?.start,
    });
  });

  it('役に立たなくなった物（頼まれた時刻を過ぎた等）は送らない', () => {
    const events = backupAskedOfKenta().events;
    const before = intentsAt(events, '2026-11-30T17:00+09:00');
    const isWrite = (i: { subject: { type: string; id: string } }) =>
      i.subject.type === 'task' && i.subject.id === write;
    expect(before.some(isWrite)).toBe(true);
    // 記入の時刻（17:20）を過ぎたら、まだ引き受けていなくても、その知らせは出さない。
    const after = intentsAt(events, '2026-11-30T17:25+09:00');
    expect(after.some(isWrite)).toBe(false);
    for (const intent of after) {
      if (intent.until)
        expect(toEpochMinutes(intent.until)).toBeGreaterThan(
          toEpochMinutes('2026-11-30T17:25+09:00'),
        );
    }
  });

  it('キーと文に、家族の名前・場所の名前を入れない。頼まれた場所の ID もキーに入れない', () => {
    const names = [
      ...household.members.flatMap((m) => [m.name, m.addressAs ?? '']),
      ...household.places.map((p) => p.name),
    ].filter((s) => s.length > 1);
    // 決め時が近い買い物（仕組みの提案）：店で買う作業。
    const buy = intentsAt(asked().events, '2026-12-03T18:00+09:00');
    expect(buy.map((i) => `${i.toMemberId}:${i.titleKey}`)).toEqual(['a:notify.proposal']);
    const store = computePlan(asked().events, '2026-12-03T18:00+09:00').tasks.find(
      (t) => t.key === 'task:opt:arr:purchase:i3:buy:buy',
    )?.atPlaceId;
    expect(store).toBeDefined();
    expect(buy[0]?.key).not.toContain(store);
    const keys = [
      ...buy,
      ...intentsAt(noticeArrived().events, '2026-11-29T16:00+09:00'),
      ...intentsAt(noticeArrived().events, '2026-12-02T18:00+09:00'),
      ...intentsAt(backupAskedOfKenta().events, '2026-11-29T21:10+09:00'),
      ...intentsAt(postponed().events, '2026-12-04T18:10+09:00'),
    ].map((i) => i.key);
    expect(keys.length).toBeGreaterThan(5);
    const texts = Object.values(NOTIFICATION_TEXT).flatMap((t) => Object.values(t));
    for (const text of [...keys, ...texts]) {
      for (const name of names) expect(text).not.toContain(name);
    }
  });
});

describe('送る文', () => {
  it('一つならその文、いくつもなら件数の文一つにまとめる（日英）', () => {
    expect(notificationMessage('ja', [{ titleKey: 'notify.cancel' }])).toEqual({
      title: 'まにあう',
      body: NOTIFICATION_TEXT.ja['notify.cancel'],
      titleKey: 'notify.cancel',
      count: 1,
    });
    const many = notificationMessage('en', [
      { titleKey: 'notify.proposal' },
      { titleKey: 'notify.decide' },
      { titleKey: 'notify.question' },
    ]);
    expect(many).toEqual({
      title: 'Maniau',
      body: '3 things need your attention.',
      titleKey: 'notify.many',
      count: 3,
    });
    expect(
      notificationMessage('ja', [{ titleKey: 'notify.decide' }, { titleKey: 'notify.backup' }])
        .body,
    ).toBe('確かめてほしいことが 2 件あります。');
  });

  it('日本語と英語で、同じ文のキーを持つ', () => {
    expect(Object.keys(NOTIFICATION_TEXT.en).sort()).toEqual(
      Object.keys(NOTIFICATION_TEXT.ja).sort(),
    );
  });
});

describe('夜は朝まで待つ', () => {
  const TZ = 'Asia/Tokyo';
  const at = (s: string) => toEpochMinutes(s);
  const morning = (s: string) => at(s);

  it('22時から7時までは、朝まで待てる物を7時まで待つ', () => {
    expect(holdUntilMorning({}, at('2026-11-29T23:30+09:00'), TZ)).toBe(
      morning('2026-11-30T07:00+09:00'),
    );
    expect(holdUntilMorning({}, at('2026-11-30T05:00+09:00'), TZ)).toBe(
      morning('2026-11-30T07:00+09:00'),
    );
    expect(holdUntilMorning({}, at('2026-11-29T22:00+09:00'), TZ)).toBe(
      morning('2026-11-30T07:00+09:00'),
    );
  });

  it('昼は待たない', () => {
    expect(holdUntilMorning({}, at('2026-11-30T07:00+09:00'), TZ)).toBeUndefined();
    expect(holdUntilMorning({}, at('2026-11-29T21:59+09:00'), TZ)).toBeUndefined();
  });

  it('本人が動く時（actBy）があれば、夜に待つかは、それで決める', () => {
    const night = at('2026-11-29T23:30+09:00');
    // 期間の終わりは遠いが、始まり（相手が動き始める時）が朝の直後なら、夜でも送る。
    expect(
      holdUntilMorning(
        { until: '2026-11-30T18:00+09:00', actBy: '2026-11-30T08:10+09:00' },
        night,
        TZ,
      ),
    ).toBeUndefined();
    // 始まりを過ぎていても（もう始まった依頼の取り消し）、待たない。
    expect(
      holdUntilMorning(
        { until: '2026-11-30T18:00+09:00', actBy: '2026-11-29T20:00+09:00' },
        night,
        TZ,
      ),
    ).toBeUndefined();
  });

  it('朝に送ると期限まで2時間の余裕が無い物は、夜でも送る', () => {
    expect(MORNING_SLACK_MIN).toBe(120);
    const night = at('2026-11-29T23:30+09:00');
    expect(holdUntilMorning({ until: '2026-11-30T08:59+09:00' }, night, TZ)).toBeUndefined();
    expect(holdUntilMorning({ until: '2026-11-30T09:00+09:00' }, night, TZ)).toBe(
      morning('2026-11-30T07:00+09:00'),
    );
  });
});
