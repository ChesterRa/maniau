// 毎日のお知らせのうち、家の人がすること（宿題のサイン・丸つけ）と、うちの番の当番を、家族の作業にする。
// 子どもだけでする宿題・子の当番・ほかの家の番と読めた当番は、作業にしない。うちの番か分からない当番は、
// 作業にして確かめてもらう。書かれた時刻は動かさず、書かれていない時刻は作らない。
import { describe, expect, it } from 'vitest';
import {
  dutyTurn,
  type Extraction,
  holdUntilMorning,
  type Item,
  notificationHistory,
  notificationIntents,
  proposalSnapshot,
  type Source,
  splitSentences,
  todayCards,
  toEpochMinutes,
} from '../src';
import { computePlan } from '../src/engine';
import { noticeArrived } from './fixtures/demo';

const TEXT = [
  'あした、音読カードにサインをお願いします。',
  '漢字ドリル12ページ。',
  '12月13日(日)8:30〜10:00 お茶当番：陽菜さん・ゆいさんのおうち',
  '12月20日(日) お茶当番：さくらさん・みおさんのおうち',
  '来週は給食当番です。',
  '12月9日(水)10:00〜11:00 読み聞かせ当番：陽菜さんのおうち',
  '12月11日(金) 学級文庫の本の修理当番：陽菜さんのおうち',
  '12月16日(水) 教室の清掃：保護者全員',
  '12月18日(金) 読み聞かせ当番：りこさんのおうち',
  '音読カードにおうちの人のはんこをもらいます。',
].join('\n');

const notice: Source = {
  id: 'n3',
  version: 1,
  receivedAt: '2026-11-25T20:00+09:00',
  sender: 'school',
  language: 'ja',
  medium: 'text',
  title: '連絡帳',
  sentences: splitSentences(TEXT, 'n3'),
};

const item = (
  id: string,
  sentence: number,
  kind: Item['kind'],
  interpretation: Item['interpretation'],
): Item => ({
  id,
  sourceId: 'n3',
  sentenceIds: [`n3#${sentence}`],
  kind,
  written: notice.sentences[sentence - 1]?.text ?? '',
  interpretation,
  evidence: 'stated',
  effects: [],
});

const extraction: Extraction = {
  sourceId: 'n3',
  unknowns: [],
  conditions: [],
  items: [
    item('h1', 1, 'homework', {
      what: '音読カードのサイン',
      date: '2026-11-26',
      relativeDay: 'tomorrow',
      familyAction: true,
    }),
    item('h2', 2, 'homework', { what: '漢字ドリル12ページ' }),
    item('d1', 3, 'duty', {
      what: 'お茶当番',
      date: '2026-12-13',
      writtenWeekday: 7,
      startTime: '08:30',
      endTime: '10:00',
      audience: '陽菜さん・ゆいさんのおうち',
      familyAction: true,
    }),
    item('d2', 4, 'duty', {
      what: 'お茶当番',
      date: '2026-12-20',
      writtenWeekday: 7,
      audience: 'さくらさん・みおさんのおうち',
      familyAction: true,
    }),
    item('d3', 5, 'duty', { what: '給食当番' }),
    item('d4', 6, 'duty', {
      what: '読み聞かせ当番',
      date: '2026-12-09',
      writtenWeekday: 3,
      startTime: '10:00',
      endTime: '11:00',
      audience: '陽菜さんのおうち',
      familyAction: true,
    }),
    item('d5', 7, 'duty', {
      what: '学級文庫の本の修理当番',
      date: '2026-12-11',
      writtenWeekday: 5,
      audience: '陽菜さんのおうち',
      familyAction: true,
    }),
    item('d6', 8, 'duty', {
      what: '教室の清掃',
      date: '2026-12-16',
      writtenWeekday: 3,
      audience: '保護者全員',
      familyAction: true,
    }),
    item('d7', 9, 'duty', {
      what: '読み聞かせ当番',
      date: '2026-12-18',
      writtenWeekday: 5,
      audience: 'りこさんのおうち',
      familyAction: true,
    }),
    item('h3', 10, 'homework', { what: '音読カードのはんこ', familyAction: true }),
  ],
  ambiguities: [],
  irrelevantSentenceIds: [],
};

/** お知らせを読んだ後。edit で、読み取りの事項を替えた物も作る（直しは前の解釈に重ねるので、欄を消せない）。 */
const withNotice = (edit: (items: Item[]) => Item[] = (items) => items) =>
  noticeArrived()
    .add('noticeReceived', '2026-11-25T20:00+09:00', 'b', { source: notice })
    .add('modelOutputRecorded', '2026-11-25T20:00+09:00', 'system', {
      call: 'extract',
      model: 'hand-written',
      promptVersion: 'fixture',
      inputHash: 'fixture-n3',
      sourceId: 'n3',
      output: { ...extraction, items: edit(extraction.items) },
    });

const NOW = '2026-11-25T20:05+09:00';
const taskOf = (events: ReturnType<typeof withNotice>['events'], key: string, now = NOW) =>
  computePlan(events, now).tasks.find((t) => t.key === key);
const unownedFor = (events: ReturnType<typeof withNotice>['events'], key: string) =>
  ['a', 'b'].map((member) =>
    todayCards(computePlan(events, NOW), member).main.some(
      (c) => c.kind === 'unowned' && c.task.key === key,
    ),
  );

describe('家の人がする宿題', () => {
  it('サインは、出す日の朝までの作業として、担当の無いまま二人に出す。子どもだけの宿題は作業にしない', () => {
    const plan = computePlan(withNotice().events, NOW);
    expect(plan.requirements.find((r) => r.key === 'req:submission:h1')).toMatchObject({
      kind: 'submission',
      what: '音読カードのサイン',
      by: '2026-11-26T08:00+09:00',
    });
    const task = plan.tasks.find((t) => t.key === 'task:submit:h1');
    expect(task).toMatchObject({
      titleKey: 'task.familyAction',
      titleParams: { what: '音読カードのサイン' },
      deadline: '2026-11-26T08:00+09:00',
      commitment: 'proposed',
      live: true,
    });
    expect(task?.assigneeId).toBeUndefined();
    expect(task?.timing).toBeUndefined();
    expect(unownedFor(withNotice().events, 'task:submit:h1')).toEqual([true, true]);
    expect(plan.requirements.some((r) => r.basis.itemIds.includes('h2'))).toBe(false);
    expect(plan.tasks.some((t) => t.basis.itemIds.includes('h2'))).toBe(false);
  });

  it('出す日の書かれていないサインも、締切を作らずに二人に出し、時刻なしで引き受けられる', () => {
    const key = 'task:submit:h3';
    const task = taskOf(withNotice().events, key);
    expect(task).toMatchObject({ titleKey: 'task.familyAction', timing: 'undated' });
    expect(task?.deadline).toBeUndefined();
    expect(task?.earliestStart).toBeUndefined();
    expect(unownedFor(withNotice().events, key)).toEqual([true, true]);
    // 持った人にも時刻を作らない。見せた控えは時刻なしで、そのまま引き受けられる。
    const held = withNotice().add('assignmentProposed', '2026-11-25T20:06+09:00', 'b', {
      taskKey: key,
      assigneeId: 'b',
    });
    const proposed = taskOf(held.events, key);
    expect(proposed?.start).toBeUndefined();
    const shown = proposed ? proposalSnapshot(proposed) : undefined;
    expect(shown).toBeDefined();
    expect(shown?.start).toBeUndefined();
    const accepted = held.add('commitmentChanged', '2026-11-25T20:07+09:00', 'b', {
      taskKey: key,
      assigneeId: 'b',
      action: 'accept',
      shown,
    });
    expect(taskOf(accepted.events, key)).toMatchObject({ commitment: 'accepted' });
    expect(taskOf(accepted.events, key)?.reconfirm).toBeUndefined();
    const cards = todayCards(computePlan(accepted.events, NOW), 'b');
    expect(cards.quiet.some((c) => c.kind === 'todo' && c.task.key === key)).toBe(true);
  });
});

describe('当番の時刻', () => {
  it('時刻の書かれた当番は、その時間に決まった作業にする（担当の無いまま二人に出す）', () => {
    const plan = computePlan(withNotice().events, NOW);
    expect(plan.requirements.find((r) => r.key === 'req:duty:d1')).toMatchObject({
      kind: 'attendance',
      what: 'お茶当番',
      date: '2026-12-13',
      by: '2026-12-13T08:30+09:00',
    });
    const task = plan.tasks.find((t) => t.key === 'task:duty:d1');
    expect(task).toMatchObject({
      titleKey: 'task.duty',
      titleParams: { what: 'お茶当番', date: '2026-12-13', start: '08:30', end: '10:00' },
      timing: 'fixed',
      earliestStart: '2026-12-13T08:30+09:00',
      deadline: '2026-12-13T10:00+09:00',
      durationMin: 90,
      commitment: 'proposed',
    });
    expect(task?.start).toBeUndefined();
    expect(task?.turnUnconfirmed).toBeUndefined();
    expect(unownedFor(withNotice().events, 'task:duty:d1')).toEqual([true, true]);
  });

  it('持った人がその時間に空いていれば、書かれた時間にそのまま置く。場所は付けない（家ではない）', () => {
    const events = withNotice().add('assignmentProposed', '2026-11-25T20:06+09:00', 'b', {
      taskKey: 'task:duty:d1',
      assigneeId: 'b',
    }).events;
    const task = taskOf(events, 'task:duty:d1');
    expect(task).toMatchObject({
      assigneeId: 'b',
      start: '2026-12-13T08:30+09:00',
      end: '2026-12-13T10:00+09:00',
      travelBeforeMin: 0,
      travelAfterMin: 0,
      travelSource: 'none',
    });
    expect(task?.atPlaceId).toBeUndefined();
    expect(task?.placeId).toBeUndefined();
  });

  it('持った人がその時間に仕事なら、前や後にずらさず、置かない', () => {
    const events = withNotice().add('assignmentProposed', '2026-11-25T20:06+09:00', 'a', {
      taskKey: 'task:duty:d4',
      assigneeId: 'a',
    }).events;
    const task = taskOf(events, 'task:duty:d4');
    expect(task).toMatchObject({
      assigneeId: 'a',
      timing: 'fixed',
      earliestStart: '2026-12-09T10:00+09:00',
      deadline: '2026-12-09T11:00+09:00',
    });
    expect(task?.start).toBeUndefined();
    // 時刻の決まった作業は、置けない時に時刻なしで引き受けさせない（重なりを隠さない）。
    expect(task ? proposalSnapshot(task) : 'none').toBeUndefined();
  });

  it('日だけの当番は、その日の物として、時刻を作らずに出す（持っても置かない。時刻なしで引き受ける）', () => {
    const key = 'task:duty:d5';
    const plan = computePlan(withNotice().events, NOW);
    expect(plan.requirements.find((r) => r.key === 'req:duty:d5')).toMatchObject({
      kind: 'attendance',
      date: '2026-12-11',
      by: '2026-12-11T00:00+09:00',
    });
    expect(plan.tasks.find((t) => t.key === key)).toMatchObject({
      timing: 'day',
      earliestStart: '2026-12-11T00:00+09:00',
      deadline: '2026-12-12T00:00+09:00',
    });
    const held = withNotice().add('assignmentProposed', '2026-11-25T20:06+09:00', 'b', {
      taskKey: key,
      assigneeId: 'b',
    });
    const task = taskOf(held.events, key);
    expect(task?.start).toBeUndefined();
    expect(task ? proposalSnapshot(task)?.titleParams : undefined).toEqual({
      what: '学級文庫の本の修理当番',
      date: '2026-12-11',
    });
  });

  it('終わりが始まりより前の時刻なら、次の日の終わりと読む（12 時間まで）。ほかは目安の長さにする', () => {
    const at = '2026-11-25T20:06+09:00';
    const night = withNotice().add('itemCorrected', at, 'a', {
      itemId: 'd1',
      interpretation: { startTime: '23:00', endTime: '01:00' },
    }).events;
    expect(taskOf(night, 'task:duty:d1')).toMatchObject({
      timing: 'fixed',
      earliestStart: '2026-12-13T23:00+09:00',
      deadline: '2026-12-14T01:00+09:00',
      durationMin: 120,
    });
    const odd = withNotice().add('itemCorrected', at, 'a', {
      itemId: 'd1',
      interpretation: { startTime: '10:00', endTime: '09:00' },
    }).events;
    expect(taskOf(odd, 'task:duty:d1')).toMatchObject({
      timing: 'fixedEndEstimated',
      earliestStart: '2026-12-13T10:00+09:00',
      deadline: '2026-12-13T11:00+09:00',
      durationMin: 60,
    });
  });

  it('終わりの書かれていない当番は、目安の長さで、終わりが目安だと印を付ける', () => {
    const noEnd = withNotice((items) =>
      items.map((i) => {
        if (i.id !== 'd1') return i;
        const { endTime: _end, ...interpretation } = i.interpretation;
        return { ...i, interpretation };
      }),
    );
    expect(taskOf(noEnd.events, 'task:duty:d1')).toMatchObject({
      timing: 'fixedEndEstimated',
      earliestStart: '2026-12-13T08:30+09:00',
      deadline: '2026-12-13T09:30+09:00',
      durationMin: 60,
      titleParams: { what: 'お茶当番', date: '2026-12-13', start: '08:30' },
    });
  });
});

describe('当番の用件', () => {
  it('書かれた場所は用件に入れ、置いても作業の場所（家）にはしない', () => {
    const events = withNotice()
      .add('itemCorrected', '2026-11-25T20:06+09:00', 'a', {
        itemId: 'd1',
        interpretation: { place: 'みらい橋小学校（架空）' },
      })
      .add('assignmentProposed', '2026-11-25T20:07+09:00', 'b', {
        taskKey: 'task:duty:d1',
        assigneeId: 'b',
      }).events;
    const task = taskOf(events, 'task:duty:d1');
    expect(task?.titleParams).toMatchObject({ place: 'みらい橋小学校（架空）' });
    expect(task?.start).toBe('2026-12-13T08:30+09:00');
    expect(task?.atPlaceId).toBeUndefined();
  });

  it('日が直されたら、前の日の済みを当てない（日を戻せば、また済み）', () => {
    const key = 'task:duty:d1';
    const held = withNotice().add('assignmentProposed', '2026-11-25T20:06+09:00', 'b', {
      taskKey: key,
      assigneeId: 'b',
    });
    const before = taskOf(held.events, key);
    if (!before) throw new Error('当番が無い');
    const done = held.add('commitmentChanged', '2026-12-13T10:05+09:00', 'b', {
      taskKey: key,
      assigneeId: 'b',
      action: 'done',
      content: { titleKey: before.titleKey, titleParams: before.titleParams },
    });
    const now = '2026-12-13T10:10+09:00';
    expect(taskOf(done.events, key, now)?.commitment).toBe('done');
    const moved = done.add('itemCorrected', '2026-12-13T10:06+09:00', 'a', {
      itemId: 'd1',
      interpretation: { date: '2026-12-20' },
    });
    expect(taskOf(moved.events, key, now)?.commitment).not.toBe('done');
    const back = moved.add('itemCorrected', '2026-12-13T10:07+09:00', 'a', {
      itemId: 'd1',
      interpretation: { date: '2026-12-13' },
    });
    expect(taskOf(back.events, key, now)?.commitment).toBe('done');
  });
});

describe('うちの番', () => {
  it('当番表の、ほかの家の名指しだけの行は作業にしない。子の当番も作業にしない', () => {
    const plan = computePlan(withNotice().events, NOW);
    for (const id of ['d2', 'd3', 'd7']) {
      expect(plan.requirements.some((r) => r.basis.itemIds.includes(id))).toBe(false);
      expect(plan.tasks.some((t) => t.basis.itemIds.includes(id))).toBe(false);
    }
  });

  it('保護者全員のように、うちの番か分からない当番は、作業にして印を付ける。「うちの番です」で印を外す', () => {
    const key = 'task:duty:d6';
    expect(taskOf(withNotice().events, key)).toMatchObject({
      turnUnconfirmed: true,
      timing: 'day',
    });
    expect(unownedFor(withNotice().events, key)).toEqual([true, true]);
    // 読んだ中身を確かめただけ・日を直しただけでは、うちの番と言ったことにしない。
    const read = withNotice()
      .add('itemConfirmed', '2026-11-25T20:06+09:00', 'a', { itemId: 'd6' })
      .add('itemCorrected', '2026-11-25T20:07+09:00', 'a', {
        itemId: 'd6',
        interpretation: { date: '2026-12-17' },
      }).events;
    expect(taskOf(read, key)?.turnUnconfirmed).toBe(true);
    const claimed = withNotice().add('turnStated', '2026-11-25T20:06+09:00', 'a', {
      itemId: 'd6',
      ours: true,
      what: '教室の清掃',
      audience: '保護者全員',
    });
    expect(taskOf(claimed.events, key)?.turnUnconfirmed).toBeUndefined();
    // 言った後に対象が直されたら、前の言明を新しい対象に当てない。
    const moved = claimed.add('itemCorrected', '2026-11-25T20:08+09:00', 'b', {
      itemId: 'd6',
      interpretation: { audience: '1年生の保護者' },
    }).events;
    expect(taskOf(moved, key)?.turnUnconfirmed).toBe(true);
    // 「うちの番ではない」（後の言明が前の言明に代わる）：作業にしない。add は積み足すので、新しく作る。
    const notOurs = withNotice()
      .add('turnStated', '2026-11-25T20:06+09:00', 'a', {
        itemId: 'd6',
        ours: true,
        what: '教室の清掃',
        audience: '保護者全員',
      })
      .add('turnStated', '2026-11-25T20:09+09:00', 'a', {
        itemId: 'd6',
        ours: false,
        what: '教室の清掃',
        audience: '保護者全員',
      }).events;
    expect(taskOf(notOurs, key)).toBeUndefined();
  });

  it('ほかの家の番と読んだ行も、「うちの番です」と言えば作業にする（日を直しただけでは、しない）', () => {
    const corrected = withNotice().add('itemCorrected', '2026-11-25T20:06+09:00', 'a', {
      itemId: 'd2',
      interpretation: { date: '2026-12-21' },
    }).events;
    expect(taskOf(corrected, 'task:duty:d2')).toBeUndefined();
    const claimed = withNotice().add('turnStated', '2026-11-25T20:06+09:00', 'a', {
      itemId: 'd2',
      ours: true,
      what: 'お茶当番',
      audience: 'さくらさん・みおさんのおうち',
    }).events;
    expect(taskOf(claimed, 'task:duty:d2')?.turnUnconfirmed).toBeUndefined();
  });
});

describe('うちの番かの言明は、読み取りの確かさも作用も変えない', () => {
  const LATER = '2026-11-25T20:10+09:00';
  const NOW2 = '2026-11-25T20:15+09:00';
  /** 前の当番（d1：12/13 陽菜さん・ゆいさんのおうち）を、後のお知らせの行で置き換える。 */
  const replaced = () => {
    const later: Source = {
      ...notice,
      id: 'n4',
      receivedAt: LATER,
      title: '連絡帳（訂正）',
      sentences: splitSentences(
        '12月13日(日)のお茶当番は、さくらさんのおうちに変わりました。',
        'n4',
      ),
    };
    return withNotice()
      .add('noticeReceived', LATER, 'b', { source: later })
      .add('modelOutputRecorded', LATER, 'system', {
        call: 'extract',
        model: 'hand-written',
        promptVersion: 'fixture',
        inputHash: 'fixture-n4',
        sourceId: 'n4',
        output: {
          sourceId: 'n4',
          unknowns: [],
          conditions: [],
          ambiguities: [],
          irrelevantSentenceIds: [],
          items: [
            {
              id: 'e1',
              sourceId: 'n4',
              sentenceIds: ['n4#1'],
              kind: 'duty',
              written: later.sentences[0]?.text ?? '',
              interpretation: {
                what: 'お茶当番',
                date: '2026-12-13',
                writtenWeekday: 7,
                audience: 'さくらさんのおうち',
                familyAction: true,
              },
              evidence: 'stated',
              effects: [{ type: 'replace', itemId: 'd1' }],
            },
          ],
        },
      });
  };
  const teaOn13 = (events: ReturnType<typeof withNotice>['events']) =>
    computePlan(events, NOW2).tasks.filter(
      (t) => t.live && t.titleKey === 'task.duty' && t.titleParams.date === '2026-12-13',
    );

  it('置き換えた当番を「うちの番ではない」としても、置き換えは戻さない（前の当番を生き返らせない）', () => {
    // 置き換えた行は、さくらさんだけの名指しで、同じお知らせにうちの行が無いので、分からない。
    expect(teaOn13(replaced().events).map((t) => t.turnUnconfirmed)).toEqual([true]);
    const said = replaced().add('turnStated', NOW2, 'a', {
      itemId: 'e1',
      ours: false,
      what: 'お茶当番',
      audience: 'さくらさんのおうち',
    }).events;
    expect(teaOn13(said)).toEqual([]);
    // 読み違いとして外すのは別の言明で、置き換えも外れ、前の当番に戻る。
    const misread = replaced().add('itemDismissed', NOW2, 'a', {
      itemId: 'e1',
      reason: 'misread',
    }).events;
    expect(teaOn13(misread).map((t) => t.titleParams.start)).toEqual(['08:30']);
  });

  it('推定の行に「うちの番です」と言っても、読み取りを確かめたことにしない（推定のまま作業を作らない）', () => {
    const guessed = withNotice((items) =>
      items.map((i) => (i.id === 'd2' ? { ...i, evidence: 'inferred' as const } : i)),
    );
    const said = guessed.add('turnStated', '2026-11-25T20:06+09:00', 'a', {
      itemId: 'd2',
      ours: true,
      what: 'お茶当番',
      audience: 'さくらさん・みおさんのおうち',
    });
    expect(taskOf(said.events, 'task:duty:d2')).toBeUndefined();
    // 読んだ中身を家族が確かめれば（別の言明）、うちの番の作業にする。
    const read = said.add('itemConfirmed', '2026-11-25T20:07+09:00', 'a', { itemId: 'd2' });
    expect(taskOf(read.events, 'task:duty:d2')?.turnUnconfirmed).toBeUndefined();
  });

  it('読み取りに無い事項への言明は、たたむ時に除く', () => {
    const plan = computePlan(
      withNotice().add('turnStated', '2026-11-25T20:06+09:00', 'a', {
        itemId: 'zz',
        ours: true,
        what: 'お茶当番',
        audience: null,
      }).events,
      NOW,
    );
    expect(plan.tasks.some((t) => t.basis.itemIds.includes('zz'))).toBe(false);
  });
});

describe('うちの番かの決まり', () => {
  const household = noticeArrived().events.find((e) => e.type === 'householdSet');
  if (household?.type !== 'householdSet') throw new Error('家族が無い');
  const family = household.household;
  const duty = (id: string, audience: string | undefined, what = 'お茶当番'): Item =>
    item(id, 3, 'duty', {
      what,
      familyAction: true,
      ...(audience === undefined ? {} : { audience }),
    });
  const ours = duty('o', '陽菜さんのおうち');

  it('家の子の名前を含む別の名前（陽菜子さん）は、家の子としない', () => {
    expect(dutyTurn(family, duty('x', '陽菜子さんのおうち'), [])).toBe('unsure');
    expect(dutyTurn(family, duty('x', '陽菜子さんのおうち'), [ours])).toBe('others');
    expect(dutyTurn(family, duty('x', '1年2組 陽菜さん'), [])).toBe('ours');
    expect(dutyTurn(family, duty('x', '陽菜のおうち'), [])).toBe('ours');
  });

  it('誰の家か書かれていない・家の子の名前がある・家族がうちの番と言った物は、うちの番', () => {
    expect(dutyTurn(family, duty('x', undefined), [])).toBe('ours');
    expect(dutyTurn(family, duty('x', '  '), [])).toBe('ours');
    expect(dutyTurn(family, duty('x', '陽 菜さん・ゆいさんのおうち'), [])).toBe('ours');
    // 家族が「うちの番です」と言った物（その時の用件と対象のまま）。読んだ中身の確かめは、うちの番の言明ではない。
    const claim = { ours: true, what: 'お茶当番', audience: '保護者全員' };
    expect(dutyTurn(family, duty('x', '保護者全員'), [], claim)).toBe('ours');
    expect(dutyTurn(family, { ...duty('x', '保護者全員'), evidence: 'confirmed' }, [])).toBe(
      'unsure',
    );
    expect(dutyTurn(family, duty('x', '1年生の保護者'), [], claim)).toBe('unsure');
  });

  it('家族が「うちの番ではない」と言った物は、家の子の名前があっても、ほかの家の番（言った時のまま）', () => {
    const said = { ours: false, what: 'お茶当番', audience: '陽菜さんのおうち' };
    expect(dutyTurn(family, duty('x', '陽菜さんのおうち'), [], said)).toBe('others');
    // 用件か対象が直されたら、言明を当てず、書き方で決める。
    expect(dutyTurn(family, duty('x', '陽菜さん・ゆいさんのおうち'), [], said)).toBe('ours');
    expect(dutyTurn(family, duty('x', '陽菜さんのおうち', '読み聞かせ当番'), [], said)).toBe(
      'ours',
    );
  });

  it('ほかの家の名指しだけで、同じ用件のうちの行が別にある時だけ、ほかの家の番', () => {
    expect(dutyTurn(family, duty('x', 'さくらさん・みおさんのおうち'), [ours])).toBe('others');
    expect(dutyTurn(family, duty('x', 'ゆうくんと りこちゃん'), [ours])).toBe('others');
    // うちの行が無い・用件が違う時は、分からない。
    expect(dutyTurn(family, duty('x', 'さくらさんのおうち'), [])).toBe('unsure');
    expect(dutyTurn(family, duty('x', 'さくらさんのおうち', '読み聞かせ当番'), [ours])).toBe(
      'unsure',
    );
  });

  it('みんなや役を指す言葉、名指しとほかの言葉の混ざった対象は、分からない', () => {
    for (const audience of [
      '保護者全員',
      '1年生の保護者',
      '田中さんと保護者の方',
      '3組のみなさん',
    ]) {
      expect(dutyTurn(family, duty('x', audience), [ours])).toBe('unsure');
    }
  });
});

describe('当番の知らせ', () => {
  const intents = (events: ReturnType<typeof withNotice>['events'], now: string) =>
    notificationIntents(computePlan(events, now), household(), notificationHistory(events)).filter(
      (i) => i.subject.type === 'task',
    );
  const household = () => {
    const set = withNotice().events.find((e) => e.type === 'householdSet');
    if (set?.type !== 'householdSet') throw new Error('家族が無い');
    return set.household;
  };

  it('だれも持たない当番は、書かれた始まりで急ぐかを決め、夜でも朝を待たない（始まりまで 2 時間を切る）', () => {
    const now = '2026-12-12T22:05+09:00';
    const found = intents(withNotice().events, now).filter((i) =>
      i.key.startsWith('unowned:task:duty:d1:'),
    );
    expect(found.map((i) => i.toMemberId).sort()).toEqual(['a', 'b']);
    for (const intent of found) {
      expect(intent).toMatchObject({
        until: '2026-12-13T10:00+09:00',
        actBy: '2026-12-13T08:30+09:00',
      });
      expect(holdUntilMorning(intent, toEpochMinutes(now), 'Asia/Tokyo')).toBeUndefined();
    }
  });

  it('日だけの当番は、始まりを作らず、その日の終わりまでで決める（当日に届いても知らせる）', () => {
    const now = '2026-12-11T09:00+09:00';
    const found = intents(withNotice().events, now).filter((i) =>
      i.key.startsWith('unowned:task:duty:d5:'),
    );
    expect(found).toHaveLength(2);
    for (const intent of found) {
      expect(intent.until).toBe('2026-12-12T00:00+09:00');
      expect(intent.actBy).toBeUndefined();
    }
  });
});

describe('始まりを確かめられなかった当番', () => {
  // 読み聞かせ当番（12/9）の始まりを、読み取りで確かめられずに落とした。
  const dropped = () =>
    withNotice((items) =>
      items.map((i) =>
        i.id === 'd4'
          ? {
              ...i,
              interpretation: {
                what: '読み聞かせ当番',
                date: '2026-12-09',
                writtenWeekday: 3,
                audience: '陽菜さんのおうち',
                familyAction: true,
                startTimeUnconfirmed: true as const,
              },
            }
          : i,
      ),
    ).events;
  const household = () => {
    const set = withNotice().events.find((e) => e.type === 'householdSet');
    if (set?.type !== 'householdSet') throw new Error('家族が無い');
    return set.household;
  };
  const unowned = (events: ReturnType<typeof withNotice>['events'], key: string, now: string) =>
    notificationIntents(computePlan(events, now), household(), notificationHistory(events)).filter(
      (i) => i.key.startsWith(`unowned:${key}:`),
    );

  it('日だけの当番にして、確かめていないと印を付ける', () => {
    expect(taskOf(dropped(), 'task:duty:d4')).toMatchObject({
      timing: 'day',
      timeUnconfirmed: true,
    });
    // ほかの日だけの当番には付けない。
    expect(taskOf(dropped(), 'task:duty:d5')?.timeUnconfirmed).toBeUndefined();
  });

  it('その日の始まりを目安に早めて知らせ、その日に入った後も、朝を待たずに知らせる', () => {
    const before = unowned(dropped(), 'task:duty:d4', '2026-12-08T08:00+09:00');
    expect(before).toHaveLength(2);
    for (const intent of before) {
      expect(intent).toMatchObject({
        until: '2026-12-10T00:00+09:00',
        actBy: '2026-12-09T00:00+09:00',
      });
    }
    // その日の 6:55 に届いた：目安（0 時）は過ぎたが、知らせは止めず、7 時を待たない（7 時かもしれない）。
    const early = '2026-12-09T06:55+09:00';
    const sameDay = unowned(dropped(), 'task:duty:d4', early);
    expect(sameDay).toHaveLength(2);
    for (const intent of sameDay) {
      expect(holdUntilMorning(intent, toEpochMinutes(early), 'Asia/Tokyo')).toBeUndefined();
    }
    // 始まりの書かれていない、ふつうの日だけの当番は、朝を待つ。
    const plain = '2026-12-11T06:55+09:00';
    const day = unowned(withNotice().events, 'task:duty:d5', plain);
    expect(day).toHaveLength(2);
    for (const intent of day) {
      expect(holdUntilMorning(intent, toEpochMinutes(plain), 'Asia/Tokyo')).toBeDefined();
    }
  });
});

describe('ほかの家の番の根拠', () => {
  const lines = [
    '晴れなら、12月13日(日) お茶当番：陽菜さんのおうち',
    '12月20日(日) お茶当番：さくらさんのおうち',
  ];
  const table: Source = {
    id: 'n4',
    version: 1,
    receivedAt: '2026-11-25T20:00+09:00',
    sender: 'club',
    language: 'ja',
    medium: 'text',
    title: '（架空）当番表',
    sentences: splitSentences(lines.join('\n'), 'n4'),
  };
  const row = (id: string, line: number, interpretation: Item['interpretation']): Item => ({
    id,
    sourceId: 'n4',
    sentenceIds: [`n4#${line}`],
    kind: 'duty',
    written: lines[line - 1] ?? '',
    interpretation,
    evidence: 'stated',
    effects: [],
  });
  const withTable = () =>
    noticeArrived()
      .add('noticeReceived', '2026-11-25T20:00+09:00', 'b', { source: table })
      .add('modelOutputRecorded', '2026-11-25T20:00+09:00', 'system', {
        call: 'extract',
        model: 'hand-written',
        promptVersion: 'fixture',
        inputHash: 'fixture-n4',
        sourceId: 'n4',
        output: {
          sourceId: 'n4',
          unknowns: [
            { id: 'u-sunny', label: '12/13 が晴れか', values: ['yes', 'no'], kind: 'other' },
          ],
          conditions: [{ id: 'c-sunny', kind: 'eq', unknownId: 'u-sunny', value: 'yes' }],
          items: [
            {
              ...row('t1', 1, {
                what: 'お茶当番',
                date: '2026-12-13',
                audience: '陽菜さんのおうち',
                familyAction: true,
              }),
              conditionNodeId: 'c-sunny',
            },
            row('t2', 2, {
              what: 'お茶当番',
              date: '2026-12-20',
              audience: 'さくらさんのおうち',
              familyAction: true,
            }),
          ],
          ambiguities: [],
          irrelevantSentenceIds: [],
        } satisfies Extraction,
      });

  it('条件しだいの行や、条件で外れた行を根拠に、ほかの行を隠さない（分からないとして出す）', () => {
    const pending = taskOf(withTable().events, 'task:duty:t2');
    expect(pending?.turnUnconfirmed).toBe(true);
    const rained = withTable().add('answered', '2026-11-25T20:06+09:00', 'a', {
      unknownId: 'u-sunny',
      value: 'no',
    }).events;
    expect(taskOf(rained, 'task:duty:t2')?.turnUnconfirmed).toBe(true);
  });
});
