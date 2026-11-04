// 家族の一言：モデルの候補を、対象・話した人・今の状態で確かめてから見せる。
import { describe, expect, it } from 'vitest';
import {
  type PlanResult,
  recordBlock,
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

  it('まだだれも持っていない作業のことなら、計画に無いとは言わず、先に持つ人を決めてもらう', () => {
    const withUnowned: UtteranceContext = {
      ...context,
      tasks: [
        ...context.tasks,
        {
          key: 'submit',
          what: '個人面談の出欠票を出す',
          date: '2026-11-27',
          deadline: '2026-11-27T08:00+09:00',
          assigneeId: null,
          commitment: 'proposed',
          external: null,
          sent: false,
          cancels: null,
        },
      ],
    };
    const said = (o: UtteranceOutput) => toUtteranceReply(o, withUnowned, () => 'r-new');
    expect(
      said(output({ kind: 'change', actions: [action({ type: 'done', taskKey: 'submit' })] })),
    ).toEqual({ kind: 'clarify', proposals: [], reason: 'unowned' });
    // 話した人の作業と一緒に言っても、だれも持っていない作業を黙って落とさない（話した人の分は選べる）。
    const both = said(
      output({
        kind: 'change',
        actions: [
          action({ type: 'done', taskKey: 'mine-proposed' }),
          action({ type: 'done', taskKey: 'submit' }),
        ],
      }),
    );
    expect(both).toMatchObject({ kind: 'clarify', reason: 'unowned' });
    if (both.kind !== 'clarify') return;
    expect(both.proposals.map((p) => p.command)).toEqual([
      { type: 'commitment', taskKey: 'mine-proposed', action: 'done' },
    ]);
    // 別の大人の作業とも一緒なら、両方を示す。
    expect(
      said(
        output({
          kind: 'clarify',
          actions: [
            action({ type: 'withdraw', taskKey: 'his' }),
            action({ type: 'done', taskKey: 'submit' }),
          ],
        }),
      ),
    ).toEqual({ kind: 'clarify', proposals: [], reason: 'otherAdultsTask', unowned: true });
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

  it('仮の話（断られたら？）は、今返事を待っている要る頼み事だけを候補にし、何も記録しない', () => {
    // r1 は返事待ち、r2 は「はい」の後で要らなくなった物、x は前提に無い。
    expect(
      reply(
        output({
          kind: 'whatIf',
          refs: { taskKeys: [], requestIds: ['r1', 'r2', 'x', 'r1'], itemIds: [] },
        }),
      ),
    ).toEqual({ kind: 'whatIf', requestIds: ['r1'] });
    // モデルが記録の候補を一緒に出しても、仮の話からは記録の候補を作らない。
    expect(
      reply(
        output({
          kind: 'whatIf',
          actions: [action({ type: 'recordReply', requestId: 'r1', reply: 'no' })],
          refs: { taskKeys: [], requestIds: [], itemIds: [] },
        }),
      ),
    ).toEqual({ kind: 'whatIf', requestIds: [] });
    // 本当の返事か仮の話か決められない時は、どちらの候補も出さない。
    expect(reply(output({ kind: 'unsupported', unsupported: 'replyOrWhatIf' }))).toEqual({
      kind: 'unsupported',
      reason: 'replyOrWhatIf',
    });
    // 印と食い違う種類の出力（記録の候補や仮の話を一緒に出した）でも、印を付けたら候補を出さない。
    for (const kind of ['change', 'clarify', 'whatIf', 'question'] as const) {
      expect(
        reply(
          output({
            kind,
            unsupported: 'replyOrWhatIf',
            actions: [action({ type: 'recordReply', requestId: 'r1', reply: 'yes' })],
            refs: { taskKeys: [], requestIds: ['r1'], itemIds: [] },
          }),
        ),
      ).toEqual({ kind: 'unsupported', reason: 'replyOrWhatIf' });
    }
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

describe('一言の候補を記録してよいか（同じ種類の対象がほかに無い時だけ）', () => {
  const task = (key: string, live = true) => ({ key, live }) as PlanResult['tasks'][number];
  const request = (requestId: string, over: Partial<PlanResult['requests'][number]> = {}) =>
    ({
      requestId,
      state: 'awaitingReply',
      live: true,
      basis: { itemIds: [], arrangementKey: 'arr:childCare:n1:i4:c' },
      ...over,
    }) as PlanResult['requests'][number];
  const planOf = (over: Partial<PlanResult>) =>
    ({ tasks: [], requests: [], ...over }) as unknown as PlanResult;
  const ctxOf = (over: Partial<UtteranceContext>): UtteranceContext => ({
    ...context,
    tasks: [],
    requests: [],
    unknowns: [],
    ...over,
  });
  const demo = { trial: false };

  it('作業：生きている作業がほかにあれば、題や日が違っても記録させない', () => {
    const done = { type: 'commitment', taskKey: 't1', action: 'done' } as const;
    const ctx = ctxOf({
      tasks: [{ ...(context.tasks[0] as UtteranceContext['tasks'][number]), key: 't1' }],
    });
    expect(recordBlock(done, ctx, planOf({ tasks: [task('t1')] }), demo)).toBeUndefined();
    expect(recordBlock(done, ctx, planOf({ tasks: [task('t1'), task('t2')] }), demo)).toBe(
      'otherTasks',
    );
    // 生きていない作業は数えない。
    expect(
      recordBlock(done, ctx, planOf({ tasks: [task('t1'), task('t2', false)] }), demo),
    ).toBeUndefined();
    // 候補の対象が前提に無い。
    expect(recordBlock(done, ctxOf({}), planOf({ tasks: [task('t1')] }), demo)).toBe('missing');
  });

  it('頼み事：記録の先になりうる頼み事がほかにあれば記録させない。試しの家庭の「すること」の頼み事は札で', () => {
    const yes = { type: 'recordReply', requestId: 'r1', reply: 'yes' } as const;
    const cancelled = { type: 'recordCancellationSent', requestId: 'r1' } as const;
    const ctx = ctxOf({
      requests: [
        {
          id: 'r1',
          to: 'おばあちゃん',
          what: '',
          forDate: null,
          state: 'awaitingReply',
          sentBy: 'b',
          needed: true,
        },
      ],
    });
    expect(recordBlock(yes, ctx, planOf({ requests: [request('r1')] }), demo)).toBeUndefined();
    expect(recordBlock(yes, ctx, planOf({ requests: [request('r1'), request('r2')] }), demo)).toBe(
      'otherRequests',
    );
    // 取り消しを伝えた頼み事は数えない。取り消しの記録の先は、要らなくなった頼み事だけ。
    expect(
      recordBlock(
        yes,
        ctx,
        planOf({ requests: [request('r1'), request('r2', { state: 'cancelled' })] }),
        demo,
      ),
    ).toBeUndefined();
    expect(
      recordBlock(cancelled, ctx, planOf({ requests: [request('r1'), request('r2')] }), demo),
    ).toBeUndefined();
    expect(
      recordBlock(
        cancelled,
        ctx,
        planOf({ requests: [request('r1'), request('r2', { live: false })] }),
        demo,
      ),
    ).toBe('otherRequests');
    const need = request('r1', { basis: { itemIds: [], arrangementKey: 'arr:need:f-1:i1' } });
    expect(recordBlock(yes, ctx, planOf({ requests: [need] }), { trial: true })).toBe('needOnCard');
    expect(recordBlock(cancelled, ctx, planOf({ requests: [need] }), { trial: true })).toBe(
      'needOnCard',
    );
    expect(recordBlock(yes, ctx, planOf({ requests: [need] }), demo)).toBeUndefined();
    expect(recordBlock(yes, ctx, planOf({ requests: [] }), demo)).toBe('missing');
  });

  it('未定の値：家にあるかとほかの値を分けず、答えられる値がほかにあれば記録させない', () => {
    const answer = { type: 'answer', unknownId: 'u1', value: 'yes' } as const;
    const unknown = (id: string) => ({ id, label: '開催日', values: ['yes', 'no'], answer: null });
    const plan = planOf({});
    expect(recordBlock(answer, ctxOf({ unknowns: [unknown('u1')] }), plan, demo)).toBeUndefined();
    expect(
      recordBlock(
        answer,
        ctxOf({ unknowns: [unknown('u1'), unknown('u-atHome:n1:i5')] }),
        plan,
        demo,
      ),
    ).toBe('otherUnknowns');
    expect(recordBlock(answer, ctxOf({ unknowns: [unknown('u2')] }), plan, demo)).toBe('missing');
  });
});
