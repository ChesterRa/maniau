// 提出物：お知らせの「○日までに提出」は、担当の無い作業として二人の「きょう」に締切の日と出す。
import { DomainEvent } from '@maniau/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { demoEvents } from '../../server/src/demo';
import { viewFor } from '../../server/src/views';
import i18n from '../src/i18n';
import { type Ctx, SayReply, TodayScreen } from '../src/screens';
import { demoData } from './ctx';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

function withSubmission(
  options: { conditional?: boolean; takenBy?: string } = {},
): ReturnType<typeof demoEvents> {
  const events = [...demoEvents('arrived')];
  const at = '2026-11-25T20:00+09:00';
  const add = (actorId: string, body: object) => {
    const seq = events.length + 1;
    events.push(
      DomainEvent.parse({
        id: `w-${seq}`,
        householdId: events[0]?.householdId,
        seq,
        version: 1,
        occurredAt: at,
        recordedAt: at,
        actorId,
        ...body,
      }),
    );
  };
  const first = events.find((e) => e.type === 'noticeReceived');
  if (first?.type !== 'noticeReceived') throw new Error('お知らせが無い');
  const written = '個人面談の出欠票を、11月27日(金)までに提出してください。';
  add('b', {
    type: 'noticeReceived',
    source: {
      ...first.source,
      id: 'n3',
      title: '個人面談',
      sentences: [{ id: 'n3#1', text: written }],
    },
  });
  add('system', {
    type: 'modelOutputRecorded',
    call: 'extract',
    sourceId: 'n3',
    model: 'test',
    promptVersion: 'test',
    inputHash: 'test',
    output: {
      sourceId: 'n3',
      unknowns: [],
      conditions: options.conditional
        ? [{ id: 'n3:c1', kind: 'eq', unknownId: 'n1:u1', value: '2026-12-05' }]
        : [],
      irrelevantSentenceIds: [],
      ambiguities: [],
      items: [
        {
          id: 'n3:i1',
          sourceId: 'n3',
          sentenceIds: ['n3#1'],
          kind: 'submission',
          written,
          interpretation: { what: '個人面談の出欠票', date: '2026-11-27', writtenWeekday: 5 },
          ...(options.conditional ? { conditionNodeId: 'n3:c1' } : {}),
          evidence: 'stated',
          effects: [],
        },
      ],
    },
  });
  if (options.takenBy) {
    add(options.takenBy, {
      type: 'assignmentProposed',
      taskKey: 'task:submit:n3:i1',
      assigneeId: options.takenBy,
    });
  }
  return events;
}

function ctxOf(
  memberId: string,
  lang: 'ja' | 'en' = 'ja',
  events = withSubmission(),
  now = '2026-11-25T20:05+09:00',
): Ctx {
  const view = viewFor(events, memberId, now);
  const me = view.household.members.find((m) => m.id === memberId);
  if (!me) throw new Error('大人が無い');
  return {
    plan: view.plan,
    household: view.household,
    today: view.today,
    items: view.items,
    sources: new Map(view.sources.map((s) => [s.id, s])),
    readings: demoData.readings,
    me,
    lang,
    tz: view.household.timeZone,
    now: view.now,
    t: i18n.getFixedT(lang),
    outbound: (lng) => i18n.getFixedT(lng),
    send: async () => ({ status: 'ok' }),
    go: () => {},
  };
}

describe('提出物', () => {
  it('二人の「きょう」に、だれがやるか決まっていない作業として、締切の日と出す', () => {
    for (const member of ['a', 'b']) {
      const shown = text(renderToStaticMarkup(<TodayScreen ctx={ctxOf(member)} />));
      expect(shown, member).toContain('個人面談の出欠票を用意して出す');
      expect(shown, member).toContain('締切：11/27（金）');
    }
    const en = text(renderToStaticMarkup(<TodayScreen ctx={ctxOf('b', 'en')} />));
    expect(en).toContain('Prepare and hand in 個人面談の出欠票');
    expect(en).toContain('Due Fri 11/27');
  });

  it('ひとことで、まだだれも持っていない作業を済んだと言った時は、先に持つ人を決めてもらう', () => {
    const shown = text(
      renderToStaticMarkup(
        <SayReply
          ctx={ctxOf('b')}
          reply={{ kind: 'clarify', proposals: [], reason: 'unowned' }}
          busy={false}
          onRecord={() => {}}
          onClear={() => {}}
        />,
      ),
    );
    expect(shown).toContain('まだだれもやると決めていない作業があります。');
  });

  it('条件しだいの提出物は、担当のいない札でも、持った人の提案でも、その条件を書く', () => {
    const line = '学習発表会の実施日が12/5（土）なら要ります（まだ決まっていません）。';
    const unowned = text(
      renderToStaticMarkup(
        <TodayScreen ctx={ctxOf('a', 'ja', withSubmission({ conditional: true }))} />,
      ),
    );
    expect(unowned).toContain(`個人面談の出欠票を用意して出す ${line}`);
    const proposed = text(
      renderToStaticMarkup(
        <TodayScreen ctx={ctxOf('b', 'ja', withSubmission({ conditional: true, takenBy: 'b' }))} />,
      ),
    );
    expect(proposed).toContain(`個人面談の出欠票を用意して出す ${line}`);
  });

  it('締切の日の朝を過ぎて持った時は、時刻を作らず、済んだと記録できるようにする', () => {
    const late = text(
      renderToStaticMarkup(
        <TodayScreen
          ctx={ctxOf('b', 'ja', withSubmission({ takenBy: 'b' }), '2026-11-27T09:00+09:00')}
        />,
      ),
    );
    expect(late).toContain(
      '締切までに置ける時間がありません。もう済んでいたら「済んだ」を押してください。',
    );
    expect(late).toContain('済んだ');
    expect(late).not.toContain('やります');
  });
});
