import { describe, expect, it } from 'vitest';
import { PlanResult } from '../src';
import { computePlan, foldEvents } from '../src/engine';
import { extraction2, notice1, notice2, noticeArrived } from './fixtures/demo';

const CARE = 'arr:childCare:i4:c';
const SHIRT = 'arr:purchase:i3';
const opt = (template: string) => `opt:${CARE}:${template}`;

describe('文の分け方', () => {
  it('お知らせの文に、読み取りが指す番号を付ける', () => {
    expect(notice1.sentences.find((s) => s.id === 'n1#9')?.text).toBe(
      '5日(土)に行った場合、12月7日(月)は振替休業日です。',
    );
    expect(notice1.sentences).toHaveLength(12);
    expect(notice2.sentences.find((s) => s.id === 'n2#5')?.text).toContain('12月8日(火)');
  });
});

describe('お知らせが届いた夜（11/25 19:31）', () => {
  const plan = computePlan(noticeArrived().events, '2026-11-25T19:31+09:00');

  it('計画の結果の型に合う', () => {
    expect(PlanResult.safeParse(plan).success).toBe(true);
  });

  it('12/7 の子の居場所：案ごとの決め時と、安い案（学童）を勧める', () => {
    const care = plan.arrangements.find((a) => a.key === CARE);
    expect(care?.status).toBe('decidable');
    expect(care?.start).toBe('2026-12-07T08:10+09:00');
    expect(care?.end).toBe('2026-12-07T18:15+09:00');
    const deadlines = Object.fromEntries(
      care?.options.map((o) => [o.templateId, o.decisionDeadline]) ?? [],
    );
    expect(deadlines).toEqual({
      'opt-gakudo': '2026-11-30T17:20+09:00',
      'opt-leave-a': '2026-12-02T17:25+09:00',
      'opt-leave-b': '2026-12-02T17:55+09:00',
      'opt-grandma': '2026-12-04T20:55+09:00',
    });
    expect(care?.recommendedOptionKey).toBe(opt('opt-gakudo'));
  });

  it('白い長袖シャツ：家にあるかを聞く。答えが無ければ、最後の機会の前日までに', () => {
    const shirt = plan.arrangements.find((a) => a.key === SHIRT);
    expect(shirt?.status).toBe('askFirst');
    expect(shirt?.options[0]?.decisionDeadline).toBe('2026-12-04T19:05+09:00');
    expect(plan.questions).toEqual([
      {
        key: 'q:u-atHome:i3',
        unknownId: 'u-atHome:i3',
        askBy: '2026-12-03T19:05+09:00',
        fallbackValue: 'no',
        affects: [SHIRT],
      },
    ]);
  });

  it('買い物は、親Aの木曜の帰り道（豊洲駅の近くの店、21時まで）に置く', () => {
    const buy = plan.tasks.find((t) => t.key === `task:opt:${SHIRT}:buy:buy`);
    expect(buy).toMatchObject({
      assigneeId: 'a',
      start: '2026-11-26T18:55+09:00',
      end: '2026-11-26T19:10+09:00',
      atPlaceId: 'store-clothing-toyosu',
      travelBeforeMin: 5,
      travelAfterMin: 5,
      travelSource: 'estimate',
      detour: {
        plannedArrival: '2026-11-26T19:00+09:00',
        delayedArrival: '2026-11-26T19:25+09:00',
      },
    });
  });
});

describe('祖母に頼み、予備に学童の届けを出した後の延期（12/4）', () => {
  const log = noticeArrived()
    .add('answered', '2026-11-25T19:35+09:00', 'b', { unknownId: 'u-atHome:i3', value: 'no' })
    .add('optionChosen', '2026-11-25T19:36+09:00', 'b', {
      arrangementKey: CARE,
      optionKey: opt('opt-grandma'),
      role: 'primary',
    })
    .add('assignmentProposed', '2026-11-25T19:36+09:00', 'b', {
      taskKey: `task:${opt('opt-grandma')}:ask`,
      assigneeId: 'b',
    })
    .add('commitmentChanged', '2026-11-25T19:37+09:00', 'b', {
      taskKey: `task:${opt('opt-grandma')}:ask`,
      assigneeId: 'b',
      action: 'accept',
    })
    .add('externalRequestSent', '2026-11-25T19:40+09:00', 'b', {
      taskKey: `task:${opt('opt-grandma')}:ask`,
      requestId: 'r-grandma',
    });

  it('祖母の返事が来るまでは「返事しだい」で、確定と言わない', () => {
    const plan = computePlan(log.events, '2026-11-26T12:00+09:00');
    const care = plan.arrangements.find((a) => a.key === CARE);
    expect(care?.status).toBe('dependsOnReply');
    expect(care?.reasons).toEqual([{ code: 'awaitingReply', refs: ['r-grandma'] }]);
    expect(plan.requests[0]).toMatchObject({
      requestId: 'r-grandma',
      state: 'awaitingReply',
      live: true,
    });
  });

  it('本人でない人の引き受けは、状態を変えない', () => {
    const forged = noticeArrived()
      .add('assignmentProposed', '2026-11-25T19:36+09:00', 'b', {
        taskKey: `task:${opt('opt-grandma')}:ask`,
        assigneeId: 'b',
      })
      .add('commitmentChanged', '2026-11-25T19:37+09:00', 'a', {
        taskKey: `task:${opt('opt-grandma')}:ask`,
        assigneeId: 'b',
        action: 'accept',
      });
    const plan = computePlan(forged.events, '2026-11-25T19:40+09:00');
    const ask = plan.tasks.find((t) => t.key === `task:${opt('opt-grandma')}:ask`);
    expect(ask?.commitment).toBe('proposed');
  });

  it('延期の連絡で、12/7 の手配を外し、頼んだ二件に取り消しの連絡を作る。シャツは残す', () => {
    const changed = log
      .add('optionChosen', '2026-11-29T21:05+09:00', 'b', {
        arrangementKey: CARE,
        optionKey: opt('opt-gakudo'),
        role: 'backup',
      })
      .add('assignmentProposed', '2026-11-29T21:05+09:00', 'b', {
        taskKey: `task:${opt('opt-gakudo')}:submit`,
        assigneeId: 'a',
      })
      .add('commitmentChanged', '2026-11-29T21:10+09:00', 'a', {
        taskKey: `task:${opt('opt-gakudo')}:submit`,
        assigneeId: 'a',
        action: 'accept',
      })
      .add('externalRequestSent', '2026-11-30T18:00+09:00', 'a', {
        taskKey: `task:${opt('opt-gakudo')}:submit`,
        requestId: 'r-gakudo',
      })
      .add('externalReplyRecorded', '2026-11-30T18:01+09:00', 'a', {
        requestId: 'r-gakudo',
        reply: 'yes',
      })
      .add('noticeReceived', '2026-12-04T17:52+09:00', 'b', { source: notice2 })
      .add('modelOutputRecorded', '2026-12-04T17:52+09:00', 'system', {
        call: 'extract',
        model: 'hand-written',
        promptVersion: 'fixture',
        inputHash: 'fixture-n2',
        sourceId: 'n2',
        output: extraction2,
      });
    const plan = computePlan(changed.events, '2026-12-04T18:10+09:00');

    const care = plan.arrangements.find((a) => a.key === CARE);
    expect(care?.live).toBe(false);
    const cancels = plan.tasks.filter((t) => t.cancels).map((t) => [t.cancels, t.assigneeId]);
    expect(cancels).toEqual([
      ['r-grandma', 'b'],
      ['r-gakudo', 'a'],
    ]);
    // 学童の日のお弁当の準備も、根拠が消えて生きていない。
    const bento = plan.tasks.filter((t) => t.key.includes('bento'));
    expect(bento.every((t) => !t.live)).toBe(true);
    // 衣装は延期の後も要る（置き換えをたどって、同じ安定したキー）。
    const shirt = plan.requirements.find((r) => r.key === 'req:belongings:i3');
    expect(shirt?.live).toBe(true);
    expect(PlanResult.safeParse(plan).success).toBe(true);
  });
});

describe('選んだ案が使えなくなった時・要らなくなった時（§7）', () => {
  const ask = `task:${opt('opt-grandma')}:ask`;
  const submit = `task:${opt('opt-gakudo')}:submit`;
  const care = (plan: ReturnType<typeof computePlan>) =>
    plan.arrangements.find((a) => a.key === CARE);
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
  const withBackup = () =>
    asked()
      .add('optionChosen', '2026-11-29T21:05+09:00', 'b', {
        arrangementKey: CARE,
        optionKey: opt('opt-gakudo'),
        role: 'backup',
      })
      .add('assignmentProposed', '2026-11-29T21:05+09:00', 'b', {
        taskKey: submit,
        assigneeId: 'a',
      })
      .add('commitmentChanged', '2026-11-29T21:10+09:00', 'a', {
        taskKey: submit,
        assigneeId: 'a',
        action: 'accept',
      })
      .add('externalRequestSent', '2026-11-30T18:00+09:00', 'a', {
        taskKey: submit,
        requestId: 'r-gakudo',
      })
      .add('externalReplyRecorded', '2026-11-30T18:01+09:00', 'a', {
        requestId: 'r-gakudo',
        reply: 'yes',
      });

  it('祖母に断られ、予備が無ければ、残る案から選び直してもらう（取り消しは要らない）', () => {
    const log = asked().add('externalReplyRecorded', '2026-11-27T20:00+09:00', 'b', {
      requestId: 'r-grandma',
      reply: 'no',
    });
    const plan = computePlan(log.events, '2026-11-27T20:05+09:00');
    expect(care(plan)?.status).toBe('decidable');
    expect(care(plan)?.reasons).toEqual([{ code: 'turnedDown', refs: ['r-grandma'] }]);
    expect(care(plan)?.recommendedOptionKey).toBe(opt('opt-gakudo'));
    expect(plan.tasks.some((t) => t.cancels !== undefined)).toBe(false);
  });

  it('祖母に断られても、押さえた予備（学童）が確定していれば、それで決まり', () => {
    const log = withBackup().add('externalReplyRecorded', '2026-12-01T20:00+09:00', 'b', {
      requestId: 'r-grandma',
      reply: 'no',
    });
    const plan = computePlan(log.events, '2026-12-01T20:05+09:00');
    expect(care(plan)?.status).toBe('decidable');
    expect(care(plan)?.reasons).toEqual([{ code: 'turnedDown', refs: ['r-grandma'] }]);
    expect(care(plan)?.recommendedOptionKey).toBeUndefined();
    expect(plan.tasks.some((t) => t.cancels !== undefined)).toBe(false);
  });

  it('祖母が引き受けたら、予備の学童の届けは要らなくなり、出した人に取り消しの連絡を作る', () => {
    const log = withBackup().add('externalReplyRecorded', '2026-12-01T20:00+09:00', 'b', {
      requestId: 'r-grandma',
      reply: 'yes',
    });
    const plan = computePlan(log.events, '2026-12-01T20:05+09:00');
    expect(plan.requests.find((r) => r.requestId === 'r-gakudo')?.live).toBe(false);
    expect(plan.tasks.filter((t) => t.cancels !== undefined)).toEqual([
      expect.objectContaining({ cancels: 'r-gakudo', assigneeId: 'a', live: true }),
    ]);
  });

  it('確定の後に「やっぱり無理」と言われたら、断られたとして扱う', () => {
    const log = asked()
      .add('externalReplyRecorded', '2026-11-26T20:00+09:00', 'b', {
        requestId: 'r-grandma',
        reply: 'yes',
      })
      .add('externalReplyRecorded', '2026-11-28T09:00+09:00', 'b', {
        requestId: 'r-grandma',
        reply: 'no',
      });
    const plan = computePlan(log.events, '2026-11-28T09:05+09:00');
    expect(plan.requests[0]?.state).toBe('turnedDown');
    expect(care(plan)?.reasons).toEqual([{ code: 'turnedDown', refs: ['r-grandma'] }]);
  });

  it('頼んだ後に案を取り下げたら、頼んだ人に取り消しの連絡を作る', () => {
    const log = asked().add('optionDropped', '2026-11-26T08:00+09:00', 'b', {
      arrangementKey: CARE,
      optionKey: opt('opt-grandma'),
    });
    const plan = computePlan(log.events, '2026-11-26T08:05+09:00');
    expect(plan.tasks.filter((t) => t.cancels !== undefined)).toEqual([
      expect.objectContaining({ cancels: 'r-grandma', assigneeId: 'b' }),
    ]);
  });

  it('選んだ案を決め時までに始めなければ、まだ取れる案から選び直してもらう', () => {
    // 健太の有休を選んだが、申請しないまま決め時（12/2 17:25）を過ぎた。
    const log = noticeArrived().add('optionChosen', '2026-11-25T19:36+09:00', 'b', {
      arrangementKey: CARE,
      optionKey: opt('opt-leave-a'),
      role: 'primary',
    });
    const plan = computePlan(log.events, '2026-12-03T09:00+09:00');
    expect(care(plan)?.reasons).toEqual([{ code: 'missedDeadline', refs: [opt('opt-leave-a')] }]);
    expect(care(plan)?.recommendedOptionKey).toBe(opt('opt-grandma'));
  });

  it('買い物の案は一つで、取れるならそれを勧める', () => {
    const plan = computePlan(asked().events, '2026-11-25T19:45+09:00');
    expect(plan.arrangements.find((a) => a.key === SHIRT)?.recommendedOptionKey).toBe(
      `opt:${SHIRT}:buy`,
    );
  });
});

describe('同じお知らせを読み直した時', () => {
  const reading = (output: typeof extraction2, hash: string) => ({
    call: 'extract' as const,
    model: 'hand-written',
    promptVersion: 'fixture',
    inputHash: hash,
    sourceId: 'n2',
    output,
  });
  const withChange = () =>
    noticeArrived()
      .add('noticeReceived', '2026-12-04T17:52+09:00', 'b', { source: notice2 })
      .add('modelOutputRecorded', '2026-12-04T17:52+09:00', 'system', reading(extraction2, 'n2-a'));

  it('読み直しに無い作用は、前の読み取りから残さない', () => {
    const withoutEffect = {
      ...extraction2,
      items: extraction2.items.map((i) => ({
        ...i,
        effects: i.effects.filter((e) => e.type !== 'resolveUnknown'),
      })),
    };
    expect(foldEvents(withChange().events).resolved.get('u-date')?.value).toBe('2026-12-08');
    const log = withChange().add(
      'modelOutputRecorded',
      '2026-12-04T18:05+09:00',
      'system',
      reading(withoutEffect, 'n2-b'),
    );
    expect(foldEvents(log.events).resolved.has('u-date')).toBe(false);
  });

  it('読み直しは、お知らせを新しくしない：その前に来た家族の答えに勝たない', () => {
    const log = withChange()
      .add('answered', '2026-12-04T18:00+09:00', 'b', { unknownId: 'u-date', value: '2026-12-05' })
      .add('modelOutputRecorded', '2026-12-04T18:05+09:00', 'system', reading(extraction2, 'n2-c'));
    expect(foldEvents(log.events).resolved.get('u-date')).toMatchObject({
      value: '2026-12-05',
      by: 'family',
    });
  });
});

describe('買い物の担当', () => {
  const buyKey = `task:opt:${SHIRT}:buy:buy`;
  const asked = () =>
    noticeArrived()
      .add('answered', '2026-11-25T19:35+09:00', 'b', { unknownId: 'u-atHome:i3', value: 'no' })
      .add('assignmentProposed', '2026-11-25T19:40+09:00', 'b', {
        taskKey: buyKey,
        assigneeId: 'b',
      });

  it('頼まれた人の機会から選び、別の人に勝手に移さない', () => {
    const plan = computePlan(asked().events, '2026-11-25T19:45+09:00');
    const buy = plan.tasks.find((t) => t.key === buyKey);
    expect(buy?.assigneeId).toBe('b');
    expect(buy?.start).toBeDefined();
    expect(buy?.start).not.toBe('2026-11-26T18:55+09:00');
  });

  it('済んだ買い物は、置き直さない', () => {
    const log = asked().add('commitmentChanged', '2026-11-27T19:30+09:00', 'b', {
      taskKey: buyKey,
      assigneeId: 'b',
      action: 'done',
    });
    const buy = computePlan(log.events, '2026-11-29T21:00+09:00').tasks.find(
      (t) => t.key === buyKey,
    );
    expect(buy).toMatchObject({ commitment: 'done', assigneeId: 'b' });
    expect(buy?.start).toBeUndefined();
  });
});

describe('案の作業の担当', () => {
  const write = `task:${opt('opt-gakudo')}:write`;
  const placedFor = (assigneeId: string) => {
    const log = noticeArrived()
      .add('optionChosen', '2026-11-25T19:36+09:00', 'b', {
        arrangementKey: CARE,
        optionKey: opt('opt-gakudo'),
        role: 'primary',
      })
      .add('assignmentProposed', '2026-11-25T19:36+09:00', 'b', { taskKey: write, assigneeId });
    return computePlan(log.events, '2026-11-25T19:40+09:00').tasks.find((t) => t.key === write);
  };

  const submit = `task:${opt('opt-gakudo')}:submit`;
  const splitBetween = (writer: string, submitter: string) =>
    noticeArrived()
      .add('optionChosen', '2026-11-25T19:36+09:00', 'b', {
        arrangementKey: CARE,
        optionKey: opt('opt-gakudo'),
        role: 'primary',
      })
      .add('assignmentProposed', '2026-11-25T19:36+09:00', 'b', {
        taskKey: write,
        assigneeId: writer,
      })
      .add('assignmentProposed', '2026-11-25T19:36+09:00', 'b', {
        taskKey: submit,
        assigneeId: submitter,
      });

  it('手順の担当が前後で別の人なら、紙の受け渡しが分からないので、どの手順にも時刻を置かない', () => {
    for (const [writer, submitter] of [
      ['a', 'b'],
      ['b', 'a'],
    ] as const) {
      const log = splitBetween(writer, submitter);
      const plan = computePlan(log.events, '2026-11-25T19:40+09:00');
      for (const [key, who] of [
        [write, writer],
        [submit, submitter],
      ] as const) {
        const task = plan.tasks.find((t) => t.key === key);
        expect(task?.assigneeId).toBe(who);
        expect(task?.handoff).toBe(true);
        expect(task?.start).toBeUndefined();
        expect(task?.end).toBeUndefined();
      }
      // 案の決め時は、一人で続けてする置き方で求めたまま残す（誰かが間に合うか）。
      const option = plan.arrangements
        .flatMap((a) => a.options)
        .find((o) => o.key === opt('opt-gakudo'));
      expect(option?.decisionDeadline).toBeDefined();
    }
  });

  it('同じ人が続けてするなら、受け渡しの印を付けず、その人の時間に置く', () => {
    const plan = computePlan(splitBetween('a', 'a').events, '2026-11-25T19:40+09:00');
    for (const key of [write, submit]) {
      const task = plan.tasks.find((t) => t.key === key);
      expect(task?.assigneeId).toBe('a');
      expect(task?.handoff).toBeUndefined();
      expect(task?.start).toBeDefined();
      expect(task?.atPlaceId).not.toBe('work-b');
    }
  });

  it('担当の決まった作業は、その人のふだんの時間と場所に置く（別の大人の職場に置かない）', () => {
    for (const who of ['a', 'b']) {
      const task = placedFor(who);
      expect(task?.assigneeId).toBe(who);
      expect(task?.start).toBeDefined();
      const other = who === 'a' ? 'work-b' : 'work-a';
      expect(task?.atPlaceId).not.toBe(other);
    }
  });
});
