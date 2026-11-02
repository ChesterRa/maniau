// 本人が見て引き受けた提案と、現在の作業を、求解のコードを使わずに照らす。
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { event, household, plan, task } from './fixtures';

const issueCodes = (report: ReturnType<typeof verifyPlan>, kind?: 'violation' | 'undetermined') =>
  report.issues
    .filter((issue) => kind === undefined || issue.kind === kind)
    .map((issue) => issue.code);

const shown = {
  start: '2026-12-07T10:00+09:00',
  end: '2026-12-07T10:30+09:00',
  titleKey: 'task.t',
  titleParams: { item: 'シャツ', who: '子' },
  atPlaceId: 'store',
  travelBeforeMin: 0,
  travelAfterMin: 0,
  external: { to: 'helper', kind: 'reply' },
};
const current = (overrides: Record<string, unknown> = {}) =>
  task('t', {
    commitment: 'accepted',
    titleParams: { who: '子', item: 'シャツ' },
    atPlaceId: 'store',
    external: { to: 'helper', kind: 'reply' },
    ...overrides,
  });
const events = [
  event(1, { type: 'householdSet', household: household() }),
  event(2, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'a' }),
  event(3, { type: 'commitmentChanged', taskKey: 't', assigneeId: 'a', action: 'accept', shown }),
];

describe('本人が見た提案の控え', () => {
  it('全てが一致し、文言の値の順だけが異なるなら、再確認は要らない', () => {
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 3, tasks: [current()] }),
      events,
    });
    expect(issueCodes(report)).not.toContain('proposal_reconfirm_missing');
    expect(issueCodes(report)).not.toContain('proposal_reconfirm_unnecessary');
  });

  it('並べ替えで同順になる異なる文字のキーも、順序によらず値を照らす', () => {
    const keys = { '\u00e9': '一', 'e\u0301': '二' };
    const reversed = { 'e\u0301': '二', '\u00e9': '一' };
    const input = {
      household: household(),
      plan: plan({ throughSeq: 3, tasks: [current({ titleParams: reversed })] }),
      events: [
        ...events.slice(0, 2),
        event(3, {
          type: 'commitmentChanged',
          taskKey: 't',
          assigneeId: 'a',
          action: 'accept',
          shown: { ...shown, titleParams: keys },
        }),
      ],
    };
    expect(issueCodes(verifyPlan(input), 'violation')).not.toContain('proposal_reconfirm_missing');
    const changed = {
      ...input,
      plan: plan({
        throughSeq: 3,
        tasks: [current({ titleParams: { ...reversed, '\u00e9': '別' } })],
      }),
    };
    expect(issueCodes(verifyPlan(changed), 'violation')).toContain('proposal_reconfirm_missing');
  });

  it('時刻・用件・店・移動・外の相手のどれかが変われば、再確認が要る', () => {
    for (const changed of [
      { start: '2026-12-07T10:05+09:00' },
      { end: '2026-12-07T10:35+09:00' },
      { titleKey: 'task.other' },
      { titleParams: { item: 'ぼうし', who: '子' } },
      { atPlaceId: 'home' },
      { travelBeforeMin: 3 },
      { travelAfterMin: 3 },
      { external: { to: 'b', kind: 'reply' } },
      { external: { to: 'helper', kind: 'acceptance' } },
    ]) {
      const input = {
        household: household(),
        plan: plan({ throughSeq: 3, tasks: [current(changed)] }),
        events,
      };
      expect(issueCodes(verifyPlan(input), 'violation')).toContain('proposal_reconfirm_missing');
      const marked = {
        ...input,
        plan: plan({ throughSeq: 3, tasks: [current({ ...changed, reconfirm: true })] }),
      };
      expect(issueCodes(verifyPlan(marked), 'violation')).not.toContain(
        'proposal_reconfirm_missing',
      );
    }
  });

  it('控えがあり全て一致するのに再確認を要求しない', () => {
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 3, tasks: [current({ reconfirm: true })] }),
      events,
    });
    expect(issueCodes(report, 'violation')).toContain('proposal_reconfirm_unnecessary');
  });

  it('引き受け後に作業が未配置になれば、再確認が要る', () => {
    const input = {
      household: household(),
      events,
      plan: plan({ throughSeq: 3, tasks: [current({ start: undefined, end: undefined })] }),
    };
    expect(issueCodes(verifyPlan(input), 'violation')).toContain('proposal_reconfirm_missing');
    const marked = {
      ...input,
      plan: plan({
        throughSeq: 3,
        tasks: [current({ start: undefined, end: undefined, reconfirm: true })],
      }),
    };
    expect(issueCodes(verifyPlan(marked), 'violation')).not.toContain('proposal_reconfirm_missing');
    expect(issueCodes(verifyPlan(marked), 'undetermined')).toContain('proposal_current_unplaced');
  });

  it('控えのない旧形式の accept は、再確認されるまで現在の提案を受けたとしない', () => {
    const old = [
      ...events.slice(0, 2),
      event(3, { type: 'commitmentChanged', taskKey: 't', assigneeId: 'a', action: 'accept' }),
    ];
    const unmarked = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 3, tasks: [current()] }),
      events: old,
    });
    expect(issueCodes(unmarked, 'violation')).toContain('proposal_reconfirm_missing');
    const marked = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 3, tasks: [current({ reconfirm: true })] }),
      events: old,
    });
    expect(issueCodes(marked, 'violation')).not.toContain('proposal_reconfirm_missing');
  });

  it('引き受けた事象を確認できなければ、再確認の要否は未判定', () => {
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 2, tasks: [current({ reconfirm: true })] }),
      events: events.slice(0, 2),
    });
    expect(issueCodes(report, 'undetermined')).toContain('proposal_acceptance_unverified');
    expect(issueCodes(report, 'violation')).not.toContain('proposal_reconfirm_unnecessary');
  });

  it('担当を替え、送信の誤記を直しても、前の担当者の承諾を引き継がない', () => {
    const history = [
      ...events,
      event(4, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'b' }),
      event(5, {
        type: 'externalRequestSent',
        taskKey: 't',
        requestId: 'r',
        actorId: 'b',
        snapshot: { to: 'helper', kind: 'reply', basis: { itemIds: [] } },
      }),
      event(6, { type: 'requestRecordCorrected', requestId: 'r', actorId: 'b' }),
    ];
    const unmarked = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 6, tasks: [current({ assigneeId: 'b' })] }),
      events: history,
    });
    expect(issueCodes(unmarked, 'violation')).toContain('commitment_state_mismatch');
    const marked = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 6, tasks: [current({ assigneeId: 'b', commitment: 'proposed' })] }),
      events: history,
    });
    expect(issueCodes(marked, 'violation')).not.toContain('commitment_state_mismatch');
  });

  it('accept より後の事象でも throughSeq を越えた物は使わない', () => {
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 3, tasks: [current()] }),
      events: [...events, event(4, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'b' })],
    });
    expect(issueCodes(report)).not.toContain('proposal_reconfirm_missing');
    expect(issueCodes(report)).not.toContain('proposal_acceptance_unverified');
  });

  it('accepted でない作業に再確認の印は付けない', () => {
    const report = verifyPlan({
      household: household(),
      plan: plan({ throughSeq: 2, tasks: [current({ commitment: 'proposed', reconfirm: true })] }),
      events: events.slice(0, 2),
    });
    expect(issueCodes(report, 'violation')).toContain('proposal_reconfirm_state_invalid');
  });
});
