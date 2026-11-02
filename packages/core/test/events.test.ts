// 地基の第3段で足した事象（02-foundation §5.1・§5.2・§5.5〜§5.7）が、計画にどう効くか。
import { describe, expect, it } from 'vitest';
import { computePlan, foldEvents, liveItems, requestSnapshot } from '../src/engine';
import { proposalSnapshot } from '../src/schema/events';
import type { Extraction } from '../src/schema/source';
import { todayCards } from '../src/view/today';
import { type EventLog, extraction1, notice2, noticeArrived } from './fixtures/demo';

const CARE = 'arr:childCare:i4:c';
const GRANDMA = `opt:${CARE}:opt-grandma`;
const ASK = `task:${GRANDMA}:ask`;

/** 祖母に頼んで、送ったと記録した所まで。 */
function grandmaAsked(): EventLog {
  const log = noticeArrived()
    .add('optionChosen', '2026-11-25T19:36+09:00', 'b', {
      arrangementKey: CARE,
      optionKey: GRANDMA,
      role: 'primary',
    })
    .add('assignmentProposed', '2026-11-25T19:36+09:00', 'b', { taskKey: ASK, assigneeId: 'b' })
    .add('commitmentChanged', '2026-11-25T19:37+09:00', 'b', {
      taskKey: ASK,
      assigneeId: 'b',
      action: 'accept',
    });
  return log.add('externalRequestSent', '2026-11-25T19:40+09:00', 'b', {
    taskKey: ASK,
    requestId: 'r-grandma',
    snapshot: requestSnapshot(log.events, '2026-11-25T19:39+09:00', ASK),
  });
}

const grandma = (log: EventLog, at: string) =>
  computePlan(log.events, at).requests.find((r) => r.requestId === 'r-grandma');
const cancels = (log: EventLog, at: string) =>
  computePlan(log.events, at).tasks.some((t) => t.cancels === 'r-grandma' && t.live);

/** n1 を、与えた版の文から読み直した読み取り。 */
function reread(log: EventLog, at: string, sourceVersion: number, edit = (_: Extraction) => {}) {
  const read = structuredClone(extraction1);
  edit(read);
  return log.add('modelOutputRecorded', at, 'system', {
    call: 'extract',
    model: 'hand-written',
    promptVersion: 'fixture',
    inputHash: `fixture-n1-v${sourceVersion}-${at}`,
    sourceId: 'n1',
    sourceVersion,
    output: read,
  });
}

describe('事項への家族の確かめ・直し・「関係ない」', () => {
  it('推定の事項は、家族が確かめた後に要件を作る。読み取りに無い事項への確かめは使わない', () => {
    const log = noticeArrived();
    const read = log.events.find((e) => e.type === 'modelOutputRecorded');
    if (read?.type !== 'modelOutputRecorded') throw new Error('読み取りが無い');
    const own = structuredClone(read.output as Extraction);
    const shirt = own.items.find((i) => i.id === 'i3');
    if (!shirt) throw new Error('シャツが無い');
    shirt.evidence = 'inferred';
    read.output = own;
    expect(
      computePlan(log.events, '2026-11-25T19:31+09:00').requirements.map((r) => r.key),
    ).not.toContain('req:belongings:i3');
    log
      .add('itemConfirmed', '2026-11-25T19:32+09:00', 'a', { itemId: 'i3' })
      .add('itemConfirmed', '2026-11-25T19:32+09:00', 'a', { itemId: 'no-such-item' });
    const plan = computePlan(log.events, '2026-11-25T19:33+09:00');
    expect(plan.requirements.map((r) => r.key)).toContain('req:belongings:i3');
    expect(foldEvents(log.events).rejected.map((r) => r.reason)).toContain(
      '読み取りに無い事項への確かめ',
    );
  });

  it('子や仕組みの言明は使わない（その時の有効な大人だけ）', () => {
    const log = noticeArrived()
      .add('itemDismissed', '2026-11-25T19:32+09:00', 'c', { itemId: 'i4', reason: 'notOurs' })
      .add('sourceWithdrawn', '2026-11-25T19:32+09:00', 'system', { sourceId: 'n1' });
    const state = foldEvents(log.events);
    expect(state.verdicts.size).toBe(0);
    expect(state.withdrawnSources.size).toBe(0);
    expect(state.rejected.map((r) => r.reason)).toEqual([
      '有効な大人でない人の言明',
      '有効な大人でない人の言明',
    ]);
  });

  it('直した解釈で計画を作り、原文はそのまま残す', () => {
    const log = noticeArrived().add('itemCorrected', '2026-11-25T19:32+09:00', 'a', {
      itemId: 'i4',
      interpretation: { date: '2026-12-14' },
    });
    const item = liveItems(foldEvents(log.events)).find((i) => i.item.id === 'i4');
    expect(item?.item.interpretation.date).toBe('2026-12-14');
    expect(item?.item.evidence).toBe('confirmed');
    expect(item?.item.written).toBe(extraction1.items.find((i) => i.id === 'i4')?.written);
    const care = computePlan(log.events, '2026-11-25T19:33+09:00').arrangements.find(
      (a) => a.key === CARE,
    );
    expect(care?.start).toContain('2026-12-14');
  });

  it('「関係ない」とした事項は要件を作らず、頼んだ依頼は取り消しの連絡にする。確かめ直せば戻る', () => {
    const log = grandmaAsked().add('itemDismissed', '2026-11-26T08:00+09:00', 'b', {
      itemId: 'i4',
      reason: 'notOurs',
    });
    const at = '2026-11-26T08:01+09:00';
    expect(computePlan(log.events, at).arrangements.some((a) => a.key === CARE)).toBe(false);
    expect(grandma(log, at)).toMatchObject({ live: false });
    expect(cancels(log, at)).toBe(true);

    log.add('itemConfirmed', '2026-11-26T08:05+09:00', 'b', { itemId: 'i4' });
    const back = '2026-11-26T08:06+09:00';
    expect(computePlan(log.events, back).arrangements.some((a) => a.key === CARE)).toBe(true);
    expect(grandma(log, back)).toMatchObject({ live: true });
    expect(cancels(log, back)).toBe(false);
  });
});

describe('出典の取り下げと削除', () => {
  it('取り下げたお知らせの事項は生きず、頼んだ依頼は取り消しの連絡にする', () => {
    const log = grandmaAsked().add('sourceWithdrawn', '2026-11-26T08:00+09:00', 'b', {
      sourceId: 'n1',
    });
    const at = '2026-11-26T08:01+09:00';
    const plan = computePlan(log.events, at);
    expect(
      plan.requirements.filter((r) => r.basis.itemIds.some((id) => id.startsWith('i'))),
    ).toEqual([]);
    expect(grandma(log, at)).toMatchObject({ live: false });
    expect(cancels(log, at)).toBe(true);
  });

  it('お知らせごと消したら、行事が中止になったとは推し量らず、頼った依頼は要確認にする', () => {
    const log = grandmaAsked()
      .add('sourceContentPurged', '2026-11-26T08:00+09:00', 'b', { sourceId: 'n1', scope: 'all' })
      .add('sourceContentPurged', '2026-11-26T08:00+09:00', 'system', {
        sourceId: 'n1',
        scope: 'all',
      });
    const at = '2026-11-26T08:01+09:00';
    expect(foldEvents(log.events).rejected.map((r) => r.reason)).toContain(
      '仕組みでない人の削除か、届いていない出典',
    );
    expect(grandma(log, at)).toMatchObject({ live: true, needsCheck: true });
    expect(cancels(log, at)).toBe(false);
    // 消した後に届いた読み取りは使わない。原文も状態に残さず、同じ ID で戻さない。
    reread(log, '2026-11-26T08:10+09:00', 1);
    const notice = log.events.find((e) => e.type === 'noticeReceived');
    if (notice?.type !== 'noticeReceived') throw new Error('お知らせが無い');
    log.add('noticeReceived', '2026-11-26T08:20+09:00', 'b', { source: notice.source });
    const state = foldEvents(log.events);
    expect(state.extractions.has('n1')).toBe(false);
    expect(state.sources.has('n1')).toBe(false);
    expect(state.rejected.map((r) => r.reason)).toContain('中身を消した出典と同じ ID のお知らせ');
  });

  it('取り下げた・消した出典の未定の値には、家族の答えも使わない（他の出典の事項は条件しだいに残る）', () => {
    // n1 が出した u-date に家族が答え、n3 の事項がその値を条件にしている。
    const withN3 = () =>
      noticeArrived()
        .add('answered', '2026-11-26T08:00+09:00', 'a', {
          unknownId: 'u-date',
          value: '2026-12-05',
        })
        .add('noticeReceived', '2026-11-26T09:00+09:00', 'b', {
          source: { ...notice2, id: 'n3', sentences: [{ id: 'n3#1', text: '（架空）' }] },
        })
        .add('modelOutputRecorded', '2026-11-26T09:00+09:00', 'system', {
          call: 'extract',
          model: 'hand-written',
          promptVersion: 'fixture',
          inputHash: 'fixture-n3-red',
          sourceId: 'n3',
          output: {
            sourceId: 'n3',
            unknowns: [],
            conditions: [
              { id: 'c-n3-held-5', kind: 'eq', unknownId: 'u-date', value: '2026-12-05' },
            ],
            items: [
              {
                id: 'k1',
                sourceId: 'n3',
                sentenceIds: ['n3#1'],
                kind: 'belongings',
                written: '（架空）5日に行う時は、赤いシャツ。',
                interpretation: { what: '赤いシャツ' },
                conditionNodeId: 'c-n3-held-5',
                evidence: 'stated',
                effects: [],
              },
            ],
            irrelevantSentenceIds: [],
            ambiguities: [],
          },
        });
    const red = (log: EventLog) =>
      liveItems(foldEvents(log.events)).find((i) => i.item.id === 'k1');
    expect(red(withN3())).toMatchObject({ conditional: false, live: true });
    const withdrawn = withN3().add('sourceWithdrawn', '2026-11-26T10:00+09:00', 'b', {
      sourceId: 'n1',
    });
    expect(red(withdrawn)).toMatchObject({ conditional: true, live: true });
    const purged = withN3().add('sourceContentPurged', '2026-11-26T10:00+09:00', 'system', {
      sourceId: 'n1',
      scope: 'all',
    });
    expect(red(purged)).toMatchObject({ conditional: true, live: true });
  });

  it('読み直しで出さなくなった未定の値も、取り下げ・削除の時は答えを使わない', () => {
    // n1 の最初の読み取りが u-date を出し、家族が答えた。読み直しは u-date を出さなかった。
    const base = () => {
      const log = noticeArrived().add('answered', '2026-11-26T08:00+09:00', 'a', {
        unknownId: 'u-date',
        value: '2026-12-05',
      });
      reread(log, '2026-11-26T08:30+09:00', 1, (read) => {
        read.unknowns = [];
      });
      return log
        .add('noticeReceived', '2026-11-26T09:00+09:00', 'b', {
          source: { ...notice2, id: 'n3', sentences: [{ id: 'n3#1', text: '（架空）' }] },
        })
        .add('modelOutputRecorded', '2026-11-26T09:00+09:00', 'system', {
          call: 'extract',
          model: 'hand-written',
          promptVersion: 'fixture',
          inputHash: 'fixture-n3-red-old',
          sourceId: 'n3',
          output: {
            sourceId: 'n3',
            unknowns: [],
            conditions: [{ id: 'c-n3-5', kind: 'eq', unknownId: 'u-date', value: '2026-12-05' }],
            items: [
              {
                id: 'k1',
                sourceId: 'n3',
                sentenceIds: ['n3#1'],
                kind: 'belongings',
                written: '（架空）5日に行う時は、赤いシャツ。',
                interpretation: { what: '赤いシャツ' },
                conditionNodeId: 'c-n3-5',
                evidence: 'stated',
                effects: [],
              },
            ],
            irrelevantSentenceIds: [],
            ambiguities: [],
          },
        });
    };
    const red = (log: EventLog) =>
      liveItems(foldEvents(log.events)).find((i) => i.item.id === 'k1');
    expect(red(base())).toMatchObject({ conditional: false });
    expect(
      red(base().add('sourceWithdrawn', '2026-11-26T10:00+09:00', 'b', { sourceId: 'n1' })),
    ).toMatchObject({ conditional: true, live: true });
    expect(
      red(
        base().add('sourceContentPurged', '2026-11-26T10:00+09:00', 'system', {
          sourceId: 'n1',
          scope: 'all',
        }),
      ),
    ).toMatchObject({ conditional: true, live: true });
  });

  it('写真だけ消しても、計画は変わらない', () => {
    const before = computePlan(grandmaAsked().events, '2026-11-26T08:01+09:00');
    const log = grandmaAsked().add('sourceContentPurged', '2026-11-26T08:00+09:00', 'system', {
      sourceId: 'n1',
      scope: 'photo',
    });
    const after = computePlan(log.events, '2026-11-26T08:01+09:00');
    expect(after.requirements).toEqual(before.requirements);
    expect(after.requests).toEqual(before.requests);
  });
});

describe('読み取りの出典', () => {
  it('記録・読み取り・事項の出典が揃わない読み取りや、届いていない出典の読み取りは使わない', () => {
    const before = foldEvents(noticeArrived().events).extractions.get('n1');
    const log = noticeArrived();
    const mixed = structuredClone(extraction1);
    const shirt = mixed.items.find((i) => i.id === 'i3');
    if (!shirt) throw new Error('シャツが無い');
    shirt.interpretation = { ...shirt.interpretation, what: '赤い帽子' };
    const record = (sourceId: string, output: Extraction, hash: string) =>
      log.add('modelOutputRecorded', '2026-11-25T19:40+09:00', 'system', {
        call: 'extract',
        model: 'hand-written',
        promptVersion: 'fixture',
        inputHash: hash,
        sourceId,
        output,
      });
    record('n2', mixed, 'wrong-record');
    const strayItem = structuredClone(mixed);
    const stray = strayItem.items[0];
    if (!stray) throw new Error('事項が無い');
    stray.sourceId = 'n2';
    record('n1', strayItem, 'wrong-item');
    record('n9', { ...structuredClone(mixed), sourceId: 'n9', items: [] }, 'not-received');
    const state = foldEvents(log.events);
    expect(state.extractions.get('n1')).toEqual(before);
    expect(state.extractions.has('n9')).toBe(false);
    const reasons = state.rejected.map((r) => r.reason);
    expect(reasons.filter((r) => r === '出典の揃わない読み取り')).toHaveLength(2);
    expect(reasons).toContain('届いていない出典の読み取り');
  });
});

describe('書き起こしを直した後の読み直し', () => {
  it('直す前の版から読んだ事項は、読み直すまで確かとしない。古い版の読み取りが後で届いても使わない', () => {
    const log = grandmaAsked().add('transcriptionCorrected', '2026-11-26T08:00+09:00', 'b', {
      sourceId: 'n1',
      sourceVersion: 2,
      sentences: extraction1.items
        .flatMap((i) => i.sentenceIds)
        .map((id) => ({ id, text: '（直した文）' })),
    });
    const at = '2026-11-26T08:01+09:00';
    expect(liveItems(foldEvents(log.events)).find((i) => i.item.id === 'i4')).toMatchObject({
      conditional: true,
    });
    expect(grandma(log, at)).toMatchObject({ live: true, needsCheck: true });

    // 直した版を読んだ読み取りが届けば、確かに戻る。
    reread(log, '2026-11-26T08:05+09:00', 2);
    expect(grandma(log, '2026-11-26T08:06+09:00')?.needsCheck).toBeUndefined();

    // 直す前に始めた読み取りが、後で届いても、新しい読み取りを置き換えない。
    reread(log, '2026-11-26T08:07+09:00', 1, (read) => {
      read.items = read.items.filter((i) => i.id !== 'i4');
    });
    const state = foldEvents(log.events);
    expect(state.rejected.map((r) => r.reason)).toContain('前の版の文を読んだ読み取り');
    expect(state.extractions.get('n1')?.items.some((i) => i.id === 'i4')).toBe(true);
  });

  it('直した後に届いた、読んだ版の分からない読み取りや、まだ無い版の読み取りは使わない', () => {
    const corrected = () =>
      grandmaAsked().add('transcriptionCorrected', '2026-11-26T08:00+09:00', 'b', {
        sourceId: 'n1',
        sourceVersion: 2,
        sentences: [{ id: 'n1#1', text: '（直した文）' }],
      });
    const unversioned = corrected().add('modelOutputRecorded', '2026-11-26T08:05+09:00', 'system', {
      call: 'extract',
      model: 'hand-written',
      promptVersion: 'fixture',
      inputHash: 'fixture-n1-unversioned',
      sourceId: 'n1',
      output: structuredClone(extraction1),
    });
    expect(foldEvents(unversioned.events).rejected.map((r) => r.reason)).toContain(
      '読んだ文の版の分からない読み取り',
    );
    expect(liveItems(foldEvents(unversioned.events)).find((i) => i.item.id === 'i3')).toMatchObject(
      {
        conditional: true,
      },
    );
    const future = reread(corrected(), '2026-11-26T08:05+09:00', 3);
    expect(foldEvents(future.events).rejected.map((r) => r.reason)).toContain(
      'まだ無い版の文を読んだ読み取り',
    );
  });

  it('版の進まない直しは使わない', () => {
    const log = noticeArrived().add('transcriptionCorrected', '2026-11-26T08:00+09:00', 'b', {
      sourceId: 'n1',
      sourceVersion: 1,
      sentences: [{ id: 'n1#1', text: '（直した文）' }],
    });
    expect(foldEvents(log.events).rejected.map((r) => r.reason)).toContain(
      '書き起こしの版が進まない直し',
    );
  });
});

describe('「送った」の押し間違い', () => {
  it('送った本人が、返事の前なら、依頼を無かった事にする（取り消しの連絡は作らない）', () => {
    const log = grandmaAsked().add('requestRecordCorrected', '2026-11-25T19:45+09:00', 'b', {
      requestId: 'r-grandma',
    });
    const at = '2026-11-25T19:46+09:00';
    const plan = computePlan(log.events, at);
    expect(plan.requests).toEqual([]);
    expect(plan.tasks.find((t) => t.key === ASK)?.commitment).toBe('accepted');
    expect(plan.tasks.some((t) => t.cancels === 'r-grandma')).toBe(false);
  });

  it('送る前の状態に戻す。前の担当の引き受けを、引き受けていない次の担当に引き継がない', () => {
    // a が見て引き受けた後、担当を b に替える。b は引き受けずに「送った」を押し、すぐ直す。
    const log = noticeArrived()
      .add('optionChosen', '2026-11-25T19:36+09:00', 'b', {
        arrangementKey: CARE,
        optionKey: GRANDMA,
        role: 'primary',
      })
      .add('assignmentProposed', '2026-11-25T19:36+09:00', 'b', { taskKey: ASK, assigneeId: 'a' });
    const before = computePlan(log.events, '2026-11-25T19:37+09:00').tasks.find(
      (t) => t.key === ASK,
    );
    const shown = before && proposalSnapshot(before);
    if (!shown) throw new Error('置けていない');
    log
      .add('commitmentChanged', '2026-11-25T19:37+09:00', 'a', {
        taskKey: ASK,
        assigneeId: 'a',
        action: 'accept',
        shown,
      })
      .add('assignmentProposed', '2026-11-25T19:38+09:00', 'a', { taskKey: ASK, assigneeId: 'b' })
      .add('externalRequestSent', '2026-11-25T19:40+09:00', 'b', {
        taskKey: ASK,
        requestId: 'r-mistake',
      })
      .add('requestRecordCorrected', '2026-11-25T19:41+09:00', 'b', { requestId: 'r-mistake' });
    const state = foldEvents(log.events);
    expect(state.shown.has(ASK)).toBe(false);
    const after = computePlan(log.events, '2026-11-25T19:42+09:00').tasks.find(
      (t) => t.key === ASK,
    );
    expect(after).toMatchObject({ assigneeId: 'b', commitment: 'proposed' });
  });

  it('同じ作業の二通の一方を直しても済みのまま。両方を直せば、最初に送る前へ戻す', () => {
    for (const [first, second] of [
      ['r-grandma', 'r-again'],
      ['r-again', 'r-grandma'],
    ] as const) {
      const log = grandmaAsked().add('externalRequestSent', '2026-11-25T19:42+09:00', 'b', {
        taskKey: ASK,
        requestId: 'r-again',
      });
      const commitment = () =>
        computePlan(log.events, '2026-11-25T19:50+09:00').tasks.find((t) => t.key === ASK)
          ?.commitment;
      log.add('requestRecordCorrected', '2026-11-25T19:45+09:00', 'b', { requestId: first });
      expect(commitment()).toBe('done');
      log.add('requestRecordCorrected', '2026-11-25T19:46+09:00', 'b', { requestId: second });
      expect(commitment()).toBe('accepted');
    }
  });

  it('直す前に本人が「済んだ」と記録していれば、済んだは消えない', () => {
    const log = noticeArrived()
      .add('optionChosen', '2026-11-25T19:36+09:00', 'b', {
        arrangementKey: CARE,
        optionKey: GRANDMA,
        role: 'primary',
      })
      .add('assignmentProposed', '2026-11-25T19:36+09:00', 'b', { taskKey: ASK, assigneeId: 'b' })
      .add('externalRequestSent', '2026-11-25T19:40+09:00', 'b', {
        taskKey: ASK,
        requestId: 'r-mistake',
      })
      .add('commitmentChanged', '2026-11-25T19:41+09:00', 'b', {
        taskKey: ASK,
        assigneeId: 'b',
        action: 'done',
      })
      .add('requestRecordCorrected', '2026-11-25T19:42+09:00', 'b', { requestId: 'r-mistake' });
    const task = computePlan(log.events, '2026-11-25T19:43+09:00').tasks.find((t) => t.key === ASK);
    expect(task?.commitment).toBe('done');
  });

  it('直して消した依頼の ID は、もう使わない', () => {
    const log = grandmaAsked()
      .add('requestRecordCorrected', '2026-11-25T19:45+09:00', 'b', { requestId: 'r-grandma' })
      .add('externalRequestSent', '2026-11-25T19:50+09:00', 'b', {
        taskKey: ASK,
        requestId: 'r-grandma',
      });
    expect(computePlan(log.events, '2026-11-25T19:51+09:00').requests).toEqual([]);
    expect(foldEvents(log.events).rejected.map((r) => r.reason)).toContain('前に使った依頼の ID');
  });

  it('本人でない人や、返事の後には使えない', () => {
    const other = grandmaAsked().add('requestRecordCorrected', '2026-11-25T19:45+09:00', 'a', {
      requestId: 'r-grandma',
    });
    expect(grandma(other, '2026-11-25T19:46+09:00')).toBeDefined();
    const replied = grandmaAsked()
      .add('externalReplyRecorded', '2026-11-25T20:00+09:00', 'b', {
        requestId: 'r-grandma',
        reply: 'yes',
      })
      .add('requestRecordCorrected', '2026-11-25T20:05+09:00', 'b', { requestId: 'r-grandma' });
    expect(grandma(replied, '2026-11-25T20:06+09:00')).toMatchObject({ state: 'confirmed' });
    expect(foldEvents(replied.events).rejected.map((r) => r.reason)).toContain(
      '使えない「送った」の取り消し',
    );
  });
});

describe('本命と予備', () => {
  it('予備を本命にしたら予備から外し、本命を予備にも選ぶ事象は使わない', () => {
    const GAKUDO = `opt:${CARE}:opt-gakudo`;
    const choose = (log: EventLog, optionKey: string, role: 'primary' | 'backup') =>
      log.add('optionChosen', '2026-11-25T19:36+09:00', 'b', {
        arrangementKey: CARE,
        optionKey,
        role,
      });
    const arrangement = (log: EventLog) =>
      computePlan(log.events, '2026-11-25T19:40+09:00').arrangements.find((a) => a.key === CARE);
    const promoted = choose(choose(noticeArrived(), GAKUDO, 'backup'), GAKUDO, 'primary');
    expect(arrangement(promoted)).toMatchObject({ chosenOptionKey: GAKUDO, backupOptionKeys: [] });
    const both = choose(choose(noticeArrived(), GRANDMA, 'primary'), GRANDMA, 'backup');
    expect(arrangement(both)).toMatchObject({ chosenOptionKey: GRANDMA, backupOptionKeys: [] });
    expect(foldEvents(both.events).rejected.map((r) => r.reason)).toContain(
      '本命の案を予備にも選ぶ',
    );
  });
});

describe('知らせた', () => {
  const body = {
    notificationKey: 'n-1',
    toMemberId: 'b',
    channel: 'webPush' as const,
    result: 'accepted' as const,
    kind: 'question' as const,
    content: { titleKey: 'push.question', params: {} },
    appVersion: 'abc1234',
  };
  it('仕組みだけが書ける', () => {
    const log = noticeArrived()
      .add('notified', '2026-11-25T20:00+09:00', 'b', body)
      .add('notified', '2026-11-25T20:00+09:00', 'system', { ...body, notificationKey: 'n-2' });
    const state = foldEvents(log.events);
    expect([...state.notified]).toEqual(['n-2']);
    expect(state.rejected.map((r) => r.reason)).toContain('仕組みでない人の「知らせた」');
  });
});

describe('引き受けた時の提案の控え', () => {
  const buyPlan = (log: EventLog, at: string) => {
    const plan = computePlan(log.events, at);
    const task = plan.tasks.find(
      (t) => t.basis.arrangementKey === 'arr:purchase:i3' && t.start !== undefined,
    );
    if (!task) throw new Error('買い物の作業が無い');
    return { plan, task };
  };
  const answered = () =>
    noticeArrived().add('answered', '2026-11-25T19:35+09:00', 'b', {
      unknownId: 'u-atHome:i3',
      value: 'no',
    });

  it('見た提案と今の提案が同じなら、引き受けたままにする', () => {
    const log = answered();
    const { task } = buyPlan(log, '2026-11-26T12:00+09:00');
    const shown = proposalSnapshot(task);
    log
      .add('assignmentProposed', '2026-11-26T12:00+09:00', 'b', {
        taskKey: task.key,
        assigneeId: task.assigneeId ?? 'a',
      })
      .add('commitmentChanged', '2026-11-26T12:01+09:00', task.assigneeId ?? 'a', {
        taskKey: task.key,
        assigneeId: task.assigneeId ?? 'a',
        action: 'accept',
        ...(shown ? { shown } : {}),
      });
    const after = buyPlan(log, '2026-11-26T12:02+09:00').task;
    expect(after.commitment).toBe('accepted');
    expect(after.reconfirm).toBeUndefined();
  });

  it('見た提案と違う（または控えが無い）引き受けは、本人に見せ直す', () => {
    const log = answered();
    const { task } = buyPlan(log, '2026-11-26T12:00+09:00');
    const shown = proposalSnapshot(task);
    if (!shown) throw new Error('置けていない');
    const who = task.assigneeId ?? 'a';
    log
      .add('assignmentProposed', '2026-11-26T12:00+09:00', 'b', {
        taskKey: task.key,
        assigneeId: who,
      })
      .add('commitmentChanged', '2026-11-26T12:01+09:00', who, {
        taskKey: task.key,
        assigneeId: who,
        action: 'accept',
        shown: { ...shown, atPlaceId: 'somewhere-else' },
      });
    const { plan, task: after } = buyPlan(log, '2026-11-26T12:02+09:00');
    expect(after.reconfirm).toBe(true);
    const cards = todayCards(plan, who);
    expect(cards.main.some((c) => c.kind === 'proposal' && c.task.key === task.key)).toBe(true);
    expect(cards.quiet.some((c) => c.kind === 'todo' && c.task.key === task.key)).toBe(false);
  });
});
