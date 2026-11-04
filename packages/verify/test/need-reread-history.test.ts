// 再読の前と後の家族の選びを、計画の表示を根拠にせず事象から照らす。
import { DomainEvent, Household } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { collectFacts } from '../src/facts';
import { checkHistory, checkRequestNeed } from '../src/history';
import { Collector } from '../src/report';
import { event, household, plan, task } from './fixtures';

const home = Household.parse({
  ...household(),
  ways: ['way-a', 'way-b'].map((id) => ({
    id,
    name: id,
    steps: [
      {
        id: 'ask',
        name: '頼む',
        durationMin: 5,
        segments: ['home'],
        external: { to: 'helper', kind: 'reply' },
        cover: true,
      },
    ],
    cost: {},
  })),
});
const item = {
  id: 'item-1',
  sourceId: 'source-1',
  sentenceIds: ['sentence-1'],
  kind: 'need',
  written: '架空の用件',
  interpretation: { what: '架空の用件', shape: 'by', deadline: '2026-12-07T18:00+09:00' },
  evidence: 'stated',
  effects: [],
};
const arrangementKey = 'arr:need:item-1';
const optionKey = `opt:${arrangementKey}:way-a`;
const basis = { itemIds: ['item-1'], requirementKey: 'requirement', arrangementKey, optionKey };
const about = (ids: string[]) =>
  JSON.stringify({
    need: { ...item.interpretation, condition: 'true' },
    ways: ids.map((id) => home.ways.find((way) => way.id === id)),
  });
const reading = (sourceVersion: number, vanished = false) => ({
  type: 'modelOutputRecorded',
  call: 'extract',
  actorId: 'system',
  sourceId: 'source-1',
  sourceVersion,
  model: 'fixture',
  promptVersion: 'fixture',
  inputHash: 'fixture',
  output: {
    sourceId: 'source-1',
    items: vanished ? [] : [item],
    unknowns: [],
    conditions: [],
    irrelevantSentenceIds: vanished ? ['sentence-1'] : [],
    ambiguities: [],
  },
});

function check(
  args: {
    remove?: boolean;
    reselect?: boolean;
    removeAgain?: boolean;
    vanished?: boolean;
    drop?: boolean;
    dismiss?: boolean;
    withdraw?: boolean;
    live?: boolean;
    cancel?: boolean;
    needsCheck?: boolean;
    noSnapshot?: boolean;
    badAbout?: boolean;
    badChoice?: boolean;
    incomplete?: boolean;
    unconfirmedAtSend?: boolean;
  } = {},
) {
  const raw = [
    event(1, { type: 'householdSet', household: home }),
    event(2, {
      type: 'noticeReceived',
      source: {
        id: 'source-1',
        version: 1,
        receivedAt: '2026-11-30T10:00+09:00',
        sender: 'school',
        language: 'ja',
        sentences: [{ id: 'sentence-1', text: '架空の用件' }],
      },
    }),
    event(3, reading(1)),
  ];
  const add = (body: Record<string, unknown>) => raw.push(event(raw.length + 1, body));
  if (!args.unconfirmedAtSend) add({ type: 'itemConfirmed', itemId: item.id });
  add({ type: 'needWaysSet', itemId: item.id, wayIds: ['way-a'], about: about(['way-a']) });
  add({ type: 'optionChosen', arrangementKey, optionKey, role: 'primary' });
  add({ type: 'assignmentProposed', taskKey: 'send', assigneeId: 'a' });
  add({
    type: 'externalRequestSent',
    taskKey: 'send',
    requestId: 'request-1',
    ...(args.noSnapshot
      ? {}
      : {
          snapshot: {
            to: 'helper',
            kind: 'reply',
            basis,
            about: args.badAbout ? '{}' : about(['way-a']),
          },
        }),
  });
  add({ type: 'externalReplyRecorded', requestId: 'request-1', reply: 'yes' });
  if (args.remove)
    add({
      type: 'needWaysSet',
      itemId: item.id,
      wayIds: ['way-b'],
      about: args.badChoice ? '{}' : about(['way-b']),
    });
  if (args.reselect)
    add({ type: 'needWaysSet', itemId: item.id, wayIds: ['way-a'], about: about(['way-a']) });
  if (args.removeAgain)
    add({ type: 'needWaysSet', itemId: item.id, wayIds: ['way-b'], about: about(['way-b']) });
  if (args.drop) add({ type: 'optionDropped', arrangementKey, optionKey });
  add({
    type: 'transcriptionCorrected',
    sourceId: 'source-1',
    sourceVersion: 2,
    sentences: [{ id: 'sentence-1', text: '架空の用件です' }],
  });
  add(reading(2, args.vanished));
  if (args.dismiss) add({ type: 'itemDismissed', itemId: item.id, reason: 'misread' });
  if (args.withdraw) add({ type: 'sourceWithdrawn', sourceId: 'source-1' });
  const events = raw
    .filter((entry) => !args.incomplete || entry.seq !== 4)
    .map((entry) => DomainEvent.parse(entry));
  const proposed = plan({
    throughSeq: raw.length,
    tasks: args.cancel ? [task('cancel', { cancels: 'request-1' })] : [],
    requests: [
      {
        requestId: 'request-1',
        taskKey: 'send',
        to: 'helper',
        kind: 'reply',
        sentAt: '2026-11-30T10:00+09:00',
        sentBy: 'a',
        state: 'confirmed',
        basis,
        live: args.live ?? false,
        ...(args.needsCheck ? { needsCheck: true } : {}),
      },
    ],
  });
  const report = new Collector();
  const history = checkHistory(home, proposed, events, report);
  const facts = collectFacts(history.events, report);
  checkRequestNeed(proposed, history, facts, report, home.timeZone);
  return report.issues.filter((issue) => issue.kind === 'violation').map((issue) => issue.code);
}

describe('確かめ待ちの再読と、それより前に送った依頼', () => {
  it('続けていた依頼を勝手に不要とし、取消しを出した計画を検出する', () => {
    expect(check({ cancel: true })).toEqual(
      expect.arrayContaining(['request_liveness_mismatch', 'unexpected_cancellation']),
    );
  });
  it('続けるか確かめる印の無い依頼を検出する', () => {
    expect(check({ live: true })).toContain('request_uncertainty_unmarked');
    expect(check({ live: true, needsCheck: true })).not.toContain('request_uncertainty_unmarked');
  });
  it('家族が別のやり方を選んで外した依頼を復活させない', () => {
    const violations = check({ remove: true, live: true });
    expect(violations).toEqual(
      expect.arrayContaining(['request_liveness_mismatch', 'cancellation_missing']),
    );
    const good = check({ remove: true, cancel: true });
    expect(good).not.toContain('request_liveness_mismatch');
    expect(good).not.toContain('unexpected_cancellation');
  });
  it('再読から元の事項が消えても、以前外した依頼の復活を検出する', () => {
    const violations = check({ remove: true, vanished: true, live: true, needsCheck: true });
    expect(violations).toEqual(
      expect.arrayContaining(['request_liveness_mismatch', 'cancellation_missing']),
    );
    const good = check({ remove: true, vanished: true, cancel: true });
    expect(good).not.toContain('request_liveness_mismatch');
    expect(good).not.toContain('unexpected_cancellation');
  });
  it('以前の選びのまま事項が見つからなくなったら、取消しを決めつけない', () => {
    expect(check({ vanished: true, cancel: true })).toEqual(
      expect.arrayContaining(['request_liveness_mismatch', 'unexpected_cancellation']),
    );
    const good = check({ vanished: true, live: true, needsCheck: true });
    expect(good).not.toContain('request_liveness_mismatch');
    expect(good).not.toContain('unexpected_cancellation');
  });
  it('案そのものを外した場合も、取消しを続ける', () => {
    expect(check({ drop: true, live: true })).toContain('request_liveness_mismatch');
    expect(check({ drop: true, cancel: true })).not.toContain('unexpected_cancellation');
  });
  it('もう一度そのやり方を選んだ履歴があれば、外したままと決めつけない', () => {
    expect(check({ remove: true, reselect: true, live: true })).not.toContain(
      'request_liveness_mismatch',
    );
    expect(check({ remove: true, reselect: true, live: true })).not.toContain(
      'cancellation_missing',
    );
  });
  it('選び直してからもう一度外したなら、最後に外した事象を採る', () => {
    expect(
      check({
        remove: true,
        reselect: true,
        removeAgain: true,
        vanished: true,
        live: true,
        needsCheck: true,
      }),
    ).toContain('cancellation_missing');
  });
  it.each([
    { noSnapshot: true },
    { badAbout: true },
    { incomplete: true },
    { unconfirmedAtSend: true },
  ])('送信時の控えや事象が確かめられない時は違反と決めない: %j', (partial) => {
    expect(check({ ...partial, cancel: true })).not.toContain('unexpected_cancellation');
    expect(check({ ...partial, remove: true, live: true })).not.toContain('cancellation_missing');
  });
  it('外した時の控えが合わなければ、外したと決めつけない', () => {
    expect(check({ remove: true, badChoice: true, live: true })).not.toContain(
      'cancellation_missing',
    );
    expect(check({ remove: true, badChoice: true, live: true })).not.toContain(
      'request_liveness_mismatch',
    );
  });
  it.each([{ noSnapshot: true }, { badAbout: true }, { badChoice: true }, { incomplete: true }])(
    '事項が消え、送信時か選びの根拠が不足すれば外したと決めつけない: %j',
    (partial) => {
      expect(
        check({ ...partial, remove: true, vanished: true, live: true, needsCheck: true }),
      ).not.toContain('cancellation_missing');
    },
  );
  it.each([{ dismiss: true }, { withdraw: true }])(
    '外した・取り下げた時は取消しを誤りとしない: %j',
    (ending) => {
      expect(check({ ...ending, cancel: true })).not.toContain('unexpected_cancellation');
    },
  );
});
