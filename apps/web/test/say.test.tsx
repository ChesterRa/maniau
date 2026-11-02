// ひとこと：一言の答えは、計画から作った文で見せる（候補の説明・聞き返し・問いの答え）。押すまで記録しない。
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { demoSessions } from '../../server/src/demo-sessions';
import type { View } from '../../server/src/views';
import type { Heard } from '../src/family';
import i18n from '../src/i18n';
import { type Ctx, SayReply, TodayScreen } from '../src/screens';
import { demoData } from './ctx';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

async function ctxOf(stage: 'chase' | 'postponed', memberId: string, lang: 'ja' | 'en' = 'ja') {
  const sessions = demoSessions();
  const id = sessions.create(stage);
  const view = (await sessions.view(id, memberId)) as View;
  const me = view.household.members.find((m) => m.id === memberId);
  if (!me) throw new Error(`大人が無い：${memberId}`);
  const ctx: Ctx = {
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
  return ctx;
}

const render = (ctx: Ctx, reply: Heard) =>
  text(
    renderToStaticMarkup(
      <SayReply ctx={ctx} reply={reply} busy={false} onRecord={() => {}} onClear={() => {}} />,
    ),
  );

describe('ひとこと', () => {
  it('候補は、相手と頼んだ日を計画から書き、押すまで記録しない', async () => {
    const ctx = await ctxOf('chase', 'b');
    const shown = render(ctx, {
      kind: 'change',
      proposals: [
        { id: 'p1', command: { type: 'recordReply', requestId: 'r-grandma', reply: 'yes' } },
      ],
    });
    expect(shown).toContain('これを記録しますか？');
    expect(shown).toContain(
      'おばあちゃんから「はい」の返事があったと記録する（振替休業日・12/7（月） 8:10–18:15の分）',
    );
    expect(shown).toContain('記録する');
    expect(shown).toContain('やめる');
    const en = render(await ctxOf('chase', 'b', 'en'), {
      kind: 'change',
      proposals: [
        { id: 'p1', command: { type: 'recordReply', requestId: 'r-grandma', reply: 'no' } },
      ],
    });
    expect(en).toContain(
      'Record that おばあちゃん said no (for 振替休業日, Mon 12/7 8:10 AM–6:15 PM)',
    );
  });

  it('頼み事の根拠の事項が見つからなければ、ほかの作業から推さず、中身が分からないと示す', async () => {
    const ctx = await ctxOf('chase', 'b');
    const lost: Ctx = {
      ...ctx,
      plan: {
        ...ctx.plan,
        requests: ctx.plan.requests.map((r) =>
          r.requestId === 'r-grandma' ? { ...r, basis: { ...r.basis, itemIds: ['n9:i9'] } } : r,
        ),
      },
    };
    const shown = render(lost, {
      kind: 'change',
      proposals: [
        { id: 'p1', command: { type: 'recordReply', requestId: 'r-grandma', reply: 'yes' } },
      ],
    });
    expect(shown).toContain('（中身の分からない頼み事・12/7（月） 8:10–18:15の分）');
  });

  it('同じ相手・同じ中身・同じ日時の頼み事がほかにもあれば、頼み事を出した手順の名前で見分ける', async () => {
    const ctx = await ctxOf('chase', 'b');
    const grandma = ctx.plan.requests.find((r) => r.requestId === 'r-grandma');
    const sender = ctx.plan.tasks.find((t) => t.key === grandma?.taskKey);
    if (!grandma || !sender) throw new Error('頼み事が無い');
    const other = {
      ...sender,
      key: 'task:other',
      titleKey: 'task.gakudoForm.write',
      titleParams: {},
    };
    const twin: Ctx = {
      ...ctx,
      plan: {
        ...ctx.plan,
        tasks: [...ctx.plan.tasks, other],
        requests: [...ctx.plan.requests, { ...grandma, requestId: 'r-other', taskKey: other.key }],
      },
    };
    const shown = render(twin, {
      kind: 'change',
      proposals: [{ id: 'p', command: { type: 'recordReply', requestId: 'r-other', reply: 'no' } }],
    });
    expect(shown).toContain('学童の申込書を書く：振替休業日・12/7（月） 8:10–18:15');
    // ほかに同じ物が無ければ、手順の名前は添えない（いつもの短い書き方）。
    expect(
      render(ctx, {
        kind: 'change',
        proposals: [
          { id: 'p', command: { type: 'recordReply', requestId: 'r-grandma', reply: 'no' } },
        ],
      }),
    ).toContain('（振替休業日・12/7（月） 8:10–18:15の分）');
  });

  it('同じ人への同じ日の頼み事は、頼んだ時間で見分け、見分けられない候補は選ばせない', async () => {
    const ctx = await ctxOf('chase', 'b');
    const grandma = ctx.plan.requests.find((r) => r.requestId === 'r-grandma');
    if (!grandma?.window) throw new Error('頼み事が無い');
    const later = { start: '2026-12-07T14:00+09:00', end: '2026-12-07T15:00+09:00' };
    const two = (window: typeof later) => ({
      ...ctx,
      plan: {
        ...ctx.plan,
        requests: [...ctx.plan.requests, { ...grandma, requestId: 'r-grandma-2', window }],
      },
    });
    const reply: Heard = {
      kind: 'clarify',
      reason: 'ambiguous',
      proposals: [
        { id: 'p1', command: { type: 'recordReply', requestId: 'r-grandma', reply: 'no' } },
        { id: 'p2', command: { type: 'recordReply', requestId: 'r-grandma-2', reply: 'no' } },
      ],
    };
    const distinct = render(two(later), reply);
    expect(distinct).toContain('（振替休業日・12/7（月） 8:10–18:15の分）');
    expect(distinct).toContain('（振替休業日・12/7（月） 14:00–15:00の分）');
    expect(distinct).not.toContain('見分けのつかない候補');
    // 時間まで同じなら、どちらも押させない（どれが記録されるか分からない）。
    const same = renderToStaticMarkup(
      <SayReply
        ctx={two(grandma.window)}
        reply={reply}
        busy={false}
        onRecord={() => {}}
        onClear={() => {}}
      />,
    );
    expect(same).not.toContain('返事があったと記録する');
    expect(text(same)).toContain('見分けのつかない候補があったので、選べるようにしていません。');
  });

  it('一部が別の大人の作業なら、その人が記録すると示し、話した人の分は選べる候補で出す', async () => {
    const ctx = await ctxOf('chase', 'a');
    const shown = render(ctx, {
      kind: 'clarify',
      reason: 'otherAdultsTask',
      proposals: [
        {
          id: 'p1',
          command: {
            type: 'commitment',
            taskKey: 'task:opt:arr:childCare:n1:i6:c:opt-gakudo:write',
            action: 'done',
          },
        },
      ],
    });
    expect(shown).toContain('ほかの大人が持っている作業のようです');
    expect(shown).toContain('どれのことですか？');
    expect(shown).toContain('学童の申込書を書く（12/7（月））を済みにする');
    expect(shown).toContain('どれでもない');
    expect(render(ctx, { kind: 'clarify', reason: 'ambiguous', proposals: [] })).toContain(
      'どれのことか決められませんでした',
    );
  });

  it('問いには、今の計画の状態と、事項の元の文へ戻る道を出す', async () => {
    const ctx = await ctxOf('chase', 'b');
    const shown = render(ctx, {
      kind: 'question',
      refs: { taskKeys: [], requestIds: ['r-grandma'], itemIds: ['n1:i1'] },
    });
    expect(shown).toContain('計画では、次のとおりです。');
    expect(shown).toContain('学習発表会・12/5（土）');
    expect(shown).toContain('条件しだい');
    expect(shown).toContain('元の文');
    expect(shown).toContain(
      'おばあちゃんへの頼み事（振替休業日・12/7（月） 8:10–18:15）：返事待ち',
    );
    expect(
      render(ctx, { kind: 'question', refs: { taskKeys: [], requestIds: [], itemIds: [] } }),
    ).toContain('当てはまる物は見つかりませんでした。');
    expect(render(ctx, { kind: 'unsupported', reason: 'routineChange' })).toContain(
      'ふだんの週（お迎え・勤務）の変更は、まだ受け付けられません。',
    );
  });

  it('問いの答えには、今は当てはまらない事項を出さない（条件の決まった後の古い参照）', async () => {
    const sessions = demoSessions();
    const id = sessions.create('chase');
    await sessions.command(id, 'a', 'op-u1', {
      type: 'answer',
      unknownId: 'n1:u1',
      value: '2026-12-05',
    });
    const view = (await sessions.view(id, 'b')) as View;
    const base = await ctxOf('chase', 'b');
    const ctx: Ctx = { ...base, plan: view.plan, items: view.items, today: view.today };
    const shown = render(ctx, {
      kind: 'question',
      refs: { taskKeys: [], requestIds: [], itemIds: ['n1:i7'] },
    });
    expect(shown).toContain('当てはまる物は見つかりませんでした。');
    expect(shown).not.toContain('通常授業');
  });

  it('問いの答えで、推定・食い違いの事項は、確かめていないと示す', async () => {
    const base = await ctxOf('chase', 'b');
    const ctx: Ctx = {
      ...base,
      items: base.items.map((l) =>
        l.item.id === 'n1:i5'
          ? { ...l, trusted: false, item: { ...l.item, evidence: 'conflicting' as const } }
          : l,
      ),
    };
    const shown = render(ctx, {
      kind: 'question',
      refs: { taskKeys: [], requestIds: [], itemIds: ['n1:i5'] },
    });
    expect(shown).toContain('白い長袖シャツ');
    expect(shown).toContain('要確認');
  });

  it('問いの答えで、要らなくなった頼み事は、返事待ちのままでも取り消しを伝えると示す', async () => {
    const ctx = await ctxOf('postponed', 'b');
    const grandma = ctx.plan.requests.find((r) => r.requestId === 'r-grandma');
    expect(grandma).toMatchObject({ live: false, state: 'awaitingReply' });
    const shown = render(ctx, {
      kind: 'question',
      refs: { taskKeys: [], requestIds: ['r-grandma'], itemIds: [] },
    });
    expect(shown).toContain(
      'おばあちゃんへの頼み事（振替休業日・12/7（月） 8:10–18:15）：返事待ち',
    );
    expect(shown).toContain('もう要りません（取り消しを伝える）');
  });

  it('一言の欄は、読めるサーバーのデモだけに出す', async () => {
    const ctx = await ctxOf('chase', 'b');
    const without = text(renderToStaticMarkup(<TodayScreen ctx={ctx} />));
    expect(without).not.toContain('ひとこと');
    const markup = renderToStaticMarkup(
      <TodayScreen
        ctx={{
          ...ctx,
          hear: async () => ({ status: 'busy' }),
          confirm: async () => ({ status: 'ok' }),
        }}
      />,
    );
    const withHear = text(markup);
    expect(markup).toContain('placeholder="例：おばあちゃん、12/7は大丈夫だって"');
    expect(withHear).toContain('ひとこと');
    expect(withHear).toContain('伝える');
    expect(withHear).toContain('Anthropic に送られます');
    expect(withHear).toContain('人や場所の分かる言葉は入れないでください');
  });
});
