// 家族の一言：モデルの候補を、対象・話した人・今の状態で確かめてから見せる。
import { describe, expect, it } from 'vitest';
import {
  seenOf,
  toUtteranceReply,
  type UtteranceAction,
  type UtteranceContext,
  type UtteranceOutput,
} from '../src';

const context: UtteranceContext = {
  now: '2026-11-29T21:00+09:00',
  timeZone: 'Asia/Tokyo',
  speaker: { id: 'b', name: '彩' },
  members: [
    { id: 'a', name: '健太', kind: 'adult' },
    { id: 'b', name: '彩', kind: 'adult' },
    { id: 'g', name: 'おばあちゃん', kind: 'helper' },
  ],
  utterance: '（試験）',
  tasks: [
    {
      key: 'mine-accepted',
      what: '学童に申込書を出す',
      date: '2026-12-07',
      deadline: null,
      assigneeId: 'b',
      commitment: 'accepted',
      external: { to: '学童', kind: 'acceptance' },
      sent: false,
      cancels: null,
    },
    {
      key: 'mine-proposed',
      what: 'お弁当を作る',
      date: '2026-12-07',
      deadline: null,
      assigneeId: 'b',
      commitment: 'proposed',
      external: null,
      sent: false,
      cancels: null,
    },
    {
      key: 'his',
      what: '会社に休みを伝える',
      date: '2026-12-07',
      deadline: null,
      assigneeId: 'a',
      commitment: 'accepted',
      external: { to: '職場', kind: 'approval' },
      sent: false,
      cancels: null,
    },
    {
      key: 'cancel-r2',
      what: 'おばあちゃんに取り消しを伝える',
      date: '2026-12-14',
      deadline: null,
      assigneeId: 'b',
      commitment: 'proposed',
      external: null,
      sent: false,
      cancels: 'r2',
    },
  ],
  requests: [
    {
      id: 'r1',
      to: 'おばあちゃん',
      what: 'おばあちゃんに頼む',
      forDate: '2026-12-07',
      state: 'awaitingReply',
      sentBy: 'b',
      needed: true,
    },
    {
      id: 'r2',
      to: 'おばあちゃん',
      what: 'おばあちゃんに頼む',
      forDate: '2026-12-14',
      state: 'confirmed',
      sentBy: 'b',
      needed: false,
    },
  ],
  unknowns: [
    { id: 'u1', label: '発表会の実施日', values: ['2026-12-05', '2026-12-08'], answer: null },
  ],
  items: [
    {
      id: 'i1',
      kind: 'belongings',
      what: '図書の本',
      date: '2026-12-03',
      deadline: null,
      condition: null,
    },
  ],
};

const action = (a: Partial<UtteranceAction> & Pick<UtteranceAction, 'type'>): UtteranceAction => ({
  taskKey: null,
  requestId: null,
  reply: null,
  unknownId: null,
  value: null,
  ...a,
});

const output = (o: Partial<UtteranceOutput> & Pick<UtteranceOutput, 'kind'>): UtteranceOutput => ({
  actions: [],
  refs: { taskKeys: [], requestIds: [], itemIds: [] },
  unsupported: null,
  ...o,
});

let n = 0;
const ids = () => `req-${++n}`;
const reply = (o: UtteranceOutput) => toUtteranceReply(o, context, ids);
const commands = (r: ReturnType<typeof reply>) =>
  r.kind === 'change' || r.kind === 'clarify' ? r.proposals.map((p) => p.command) : [];

describe('家族の一言を、確かめた候補にする', () => {
  it('対象が一つに決まる変更は、見せた時の状態の控えと一緒に一つの候補にする', () => {
    const r = reply(
      output({
        kind: 'change',
        actions: [action({ type: 'recordReply', requestId: 'r1', reply: 'yes' })],
      }),
    );
    expect(r.kind).toBe('change');
    if (r.kind !== 'change') return;
    expect(r.proposals[0].command).toEqual({ type: 'recordReply', requestId: 'r1', reply: 'yes' });
    expect(r.proposals[0].seen).toEqual({ request: context.requests[0] });
  });

  it('送った・済んだは、引き受けを押していない本人の作業にも使え、新しい依頼の ID はアプリが作る', () => {
    expect(
      commands(
        reply(
          output({
            kind: 'change',
            actions: [action({ type: 'recordSent', taskKey: 'mine-accepted' })],
          }),
        ),
      ),
    ).toEqual([{ type: 'recordSent', taskKey: 'mine-accepted', requestId: expect.any(String) }]);
    expect(
      commands(
        reply(
          output({ kind: 'change', actions: [action({ type: 'done', taskKey: 'mine-proposed' })] }),
        ),
      ),
    ).toEqual([{ type: 'commitment', taskKey: 'mine-proposed', action: 'done' }]);
  });

  it('別の大人の作業は、話した人の言葉では変えない。一部だけなら、話した人の分を選べる候補で残す', () => {
    expect(
      reply(output({ kind: 'change', actions: [action({ type: 'withdraw', taskKey: 'his' })] })),
    ).toEqual({ kind: 'clarify', proposals: [], reason: 'otherAdultsTask' });
    const mixed = reply(
      output({
        kind: 'change',
        actions: [
          action({ type: 'withdraw', taskKey: 'mine-accepted' }),
          action({ type: 'withdraw', taskKey: 'his' }),
        ],
      }),
    );
    expect(mixed.kind).toBe('clarify');
    if (mixed.kind !== 'clarify') return;
    expect(mixed.reason).toBe('otherAdultsTask');
    expect(mixed.proposals.map((p) => p.command)).toEqual([
      { type: 'commitment', taskKey: 'mine-accepted', action: 'withdraw' },
    ]);
    expect(reply(output({ kind: 'unsupported', unsupported: 'otherAdultsTask' }))).toEqual({
      kind: 'clarify',
      proposals: [],
      reason: 'otherAdultsTask',
    });
  });

  it('どれのことか決められない時は、確かめた候補から選んでもらう。候補が無くても聞き返す', () => {
    const two = reply(
      output({
        kind: 'clarify',
        actions: [
          action({ type: 'recordReply', requestId: 'r1', reply: 'no' }),
          action({ type: 'recordReply', requestId: 'r1', reply: 'no' }),
          action({ type: 'answer', unknownId: 'u1', value: '2026-12-08' }),
        ],
      }),
    );
    expect(two.kind).toBe('clarify');
    expect(commands(two)).toHaveLength(2);
    expect(reply(output({ kind: 'clarify' }))).toEqual({
      kind: 'clarify',
      proposals: [],
      reason: 'ambiguous',
    });
  });

  it('返事の変わった時（「はい」の後の「いいえ」）は記録できる。同じ返事の繰り返しは出さない', () => {
    expect(
      commands(
        reply(
          output({
            kind: 'change',
            actions: [action({ type: 'recordReply', requestId: 'r2', reply: 'no' })],
          }),
        ),
      ),
    ).toEqual([{ type: 'recordReply', requestId: 'r2', reply: 'no' }]);
    expect(
      reply(
        output({
          kind: 'change',
          actions: [action({ type: 'recordReply', requestId: 'r2', reply: 'yes' })],
        }),
      ),
    ).toEqual({ kind: 'unsupported', reason: 'notInPlan' });
  });

  it('今の状態で効かない候補は出さない（同じ返事、宣言に無い値、要る頼み事の取り消し）', () => {
    const none = reply(
      output({
        kind: 'change',
        actions: [
          action({ type: 'recordReply', requestId: 'r2', reply: 'yes' }),
          action({ type: 'answer', unknownId: 'u1', value: '2026-12-09' }),
          action({ type: 'recordCancellationSent', requestId: 'r1' }),
          action({ type: 'decline', taskKey: 'mine-accepted' }),
          action({ type: 'withdraw', taskKey: 'nothing' }),
        ],
      }),
    );
    expect(none).toEqual({ kind: 'unsupported', reason: 'notInPlan' });
  });

  it('取り消しを伝える作業を済ませた時は、その頼み事に取り消しを伝えたとして記録する', () => {
    expect(
      commands(
        reply(
          output({ kind: 'change', actions: [action({ type: 'done', taskKey: 'cancel-r2' })] }),
        ),
      ),
    ).toEqual([{ type: 'recordCancellationSent', requestId: 'r2' }]);
  });

  it('問いは、今の計画にある物だけを指す（何も変えない）', () => {
    expect(
      reply(
        output({
          kind: 'question',
          refs: { taskKeys: ['his', 'gone'], requestIds: ['r1', 'r1'], itemIds: ['i1', 'x'] },
        }),
      ),
    ).toEqual({
      kind: 'question',
      refs: { taskKeys: ['his'], requestIds: ['r1'], itemIds: ['i1'] },
    });
    expect(reply(output({ kind: 'unsupported', unsupported: 'routineChange' }))).toEqual({
      kind: 'unsupported',
      reason: 'routineChange',
    });
  });

  it('控えは、対象の状態だけでなく、見せた日・用件・相手が替わっても見せた時と違う形になる', () => {
    const command = { type: 'commitment', taskKey: 'mine-accepted', action: 'withdraw' } as const;
    const before = JSON.stringify(seenOf(command, context));
    const changed = (patch: Partial<UtteranceContext['tasks'][number]>) =>
      JSON.stringify(
        seenOf(command, {
          ...context,
          tasks: context.tasks.map((t) => (t.key === 'mine-accepted' ? { ...t, ...patch } : t)),
        }),
      );
    expect(changed({ assigneeId: 'a' })).not.toBe(before);
    expect(changed({ date: '2026-12-08' })).not.toBe(before);
    expect(changed({ what: '学童に別の届を出す' })).not.toBe(before);
    expect(seenOf(command, { ...context, tasks: [] })).toEqual({ task: null });
    const reply = { type: 'recordReply', requestId: 'r1', reply: 'yes' } as const;
    expect(
      JSON.stringify(
        seenOf(reply, {
          ...context,
          requests: context.requests.map((r) =>
            r.id === 'r1' ? { ...r, forDate: '2026-12-08' } : r,
          ),
        }),
      ),
    ).not.toBe(JSON.stringify(seenOf(reply, context)));
  });
});
