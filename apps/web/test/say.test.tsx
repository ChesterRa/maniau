// ひとこと：一言の答えは、計画から作った文で見せる（候補の説明・聞き返し・問いの答え）。押すまで記録しない。

import { type Command, type PreviewCommand, proposalSnapshot } from '@maniau/core';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { demoSessions } from '../../server/src/demo-sessions';
import type { View } from '../../server/src/views';
import type { Heard } from '../src/family';
import i18n from '../src/i18n';
import { type Ctx, SayReply, SayWhatIf, TodayScreen } from '../src/screens';
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

/** 要素の木から、その文字の押し口を探して押す（フックの無い部品を、DOM なしで押す）。 */
function clickText(node: ReactNode, label: string): boolean {
  if (Array.isArray(node)) return node.some((n) => clickText(n, label));
  if (!node || typeof node !== 'object' || !('props' in node)) return false;
  const el = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
  if (el.props.children === label && el.props.onClick) {
    el.props.onClick();
    return true;
  }
  return clickText(el.props.children, label);
}

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

  it('同じ人への同じ日の頼み事は頼んだ時間で書き、同じ文の候補と、サーバーが記録させない候補は選ばせない', async () => {
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
    const reply = (blocked?: 'otherRequests'): Heard => ({
      kind: 'clarify',
      reason: 'ambiguous',
      proposals: [
        { id: 'p1', command: { type: 'recordReply', requestId: 'r-grandma', reply: 'no' } },
        { id: 'p2', command: { type: 'recordReply', requestId: 'r-grandma-2', reply: 'no' } },
      ].map((p) => (blocked ? { ...p, blocked } : p)),
    });
    const distinct = render(two(later), reply());
    expect(distinct).toContain('（振替休業日・12/7（月） 8:10–18:15の分）');
    expect(distinct).toContain('（振替休業日・12/7（月） 14:00–15:00の分）');
    expect(distinct).not.toContain('見分けのつかない候補');
    // 同じ文の候補は、どちらも押させない（どれが記録されるか分からない）。
    const same = renderToStaticMarkup(
      <SayReply
        ctx={two(grandma.window)}
        reply={reply()}
        busy={false}
        onRecord={() => {}}
        onClear={() => {}}
      />,
    );
    expect(same).not.toContain('返事があったと記録する');
    expect(text(same)).toContain('見分けのつかない候補');
    // サーバーが記録させないとした候補（ほかにも頼み事がある）は、文が違っても選ばせず、札へ案内する。
    const blocked = renderToStaticMarkup(
      <SayReply
        ctx={two(later)}
        reply={reply('otherRequests')}
        busy={false}
        onRecord={() => {}}
        onClear={() => {}}
      />,
    );
    expect(blocked).not.toContain('<button type="button" class');
    expect(text(blocked).split('ほかにも頼み事があるので、一言では記録しません')).toHaveLength(2);
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
    expect(shown).toContain('学習発表会・12/5（土） 学習発表会の実施日が12/5（土）なら');
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

  it('「すること」の頼み事は、送った時の控えの中身と手順で書き、控えに無ければ分からないと示す（今の中身で補わない）', async () => {
    const base = await ctxOf('chase', 'b');
    const original = base.plan.requests.find((r) => r.requestId === 'r-grandma');
    const first = base.items[0];
    if (!original || !first) throw new Error('頼み事か事項が無い');
    const basis = { ...original.basis, arrangementKey: 'arr:need:f-1:i1', itemIds: ['f-1:i1'] };
    // 今の事項は、送った後に直されて「変更後の用件」になっている。
    const items = [
      ...base.items,
      {
        ...first,
        item: {
          ...first.item,
          id: 'f-1:i1',
          kind: 'need' as const,
          interpretation: { what: '変更後の用件' },
        },
      },
    ];
    const ask = (
      requestId: string,
      askedNeed?: { what: string; step?: { name: string; cover: boolean } },
    ) => ({
      ...original,
      requestId,
      basis,
      ...(askedNeed ? { askedNeed } : {}),
    });
    const shownFor = (requests: ReturnType<typeof ask>[]) =>
      render(
        { ...base, items, plan: { ...base.plan, requests: [...base.plan.requests, ...requests] } },
        {
          kind: 'question',
          refs: { taskKeys: [], requestIds: requests.map((r) => r.requestId), itemIds: [] },
        },
      );
    const unknown = shownFor([ask('r-need-1')]);
    expect(unknown).toContain('中身の分からない頼み事');
    expect(unknown).not.toContain('変更後の用件');
    const asked = shownFor([ask('r-need-2', { what: '前の用件' })]);
    expect(asked).toContain('前の用件');
    expect(asked).not.toContain('変更後の用件');
    // 同じ相手・同じ中身・同じ日時の頼み事は、送った時の手順の名前で見分ける（無ければ分からない）。
    const twins = shownFor([
      ask('r-need-3', {
        what: '前の用件',
        step: { name: '祖母に来てもらえるか聞く', cover: true },
      }),
      ask('r-need-4', { what: '前の用件' }),
    ]);
    expect(twins).toContain('祖母に来てもらえるか聞く：前の用件');
    expect(twins).toContain('中身の分からない頼み事：前の用件');
  });

  it('まだ確かめていない読み取りの「すること」は、計画に入っていないと示す（確かめた後は計画として書く）', async () => {
    const base = await ctxOf('chase', 'b');
    const first = base.items[0];
    if (!first) throw new Error('事項が無い');
    const items = [
      ...base.items,
      {
        ...first,
        trusted: true,
        item: {
          ...first.item,
          id: 'f-9:i1',
          kind: 'need' as const,
          evidence: 'stated' as const,
          interpretation: { what: '説明会への参加', date: '2026-12-12' },
        },
      },
    ];
    const requirement = (unconfirmed: boolean) => ({
      key: 'req:need:f-9:i1',
      kind: 'need' as const,
      what: '説明会への参加',
      nature: 'required' as const,
      basis: { itemIds: ['f-9:i1'] },
      live: true,
      ...(unconfirmed ? { unconfirmed: true as const } : {}),
    });
    const shownWith = (unconfirmed: boolean) =>
      render(
        {
          ...base,
          items,
          plan: {
            ...base.plan,
            requirements: [...base.plan.requirements, requirement(unconfirmed)],
          },
        } as Ctx,
        { kind: 'question', refs: { taskKeys: [], requestIds: [], itemIds: ['f-9:i1'] } },
      );
    const before = shownWith(true);
    expect(before).toContain('説明会への参加・12/12（土）');
    expect(before).toContain('まだ確かめていない読み取り（計画に入っていません）');
    expect(before).not.toContain('計画では、次のとおりです。');
    const after = shownWith(false);
    expect(after).toContain('計画では、次のとおりです。');
    expect(after).not.toContain('まだ確かめていない読み取り');
  });

  describe('送った頼み事の見分け（正式の命令で作った頼み事）', () => {
    /**
     * 締切の「すること」を二つ言い、どちらも祖母のやり方を本命にして頼み（送ったと記録し）、返事の記録の候補を見る。
     * deadlines は二つの「すること」の締切。
     */
    async function twoAsked(
      needs: { deadline: string; place?: string; forMemberId?: string; what?: string }[],
    ) {
      const sessions = demoSessions();
      const id = sessions.create('arrived');
      let op = 0;
      const run = async (command: Command) => {
        const done = await sessions.command(id, 'b', `op-${++op}`, command);
        expect(done?.result).toMatchObject({ status: 'ok' });
        return done?.view as View;
      };
      const previewed = async (command: PreviewCommand) => {
        const shown = await sessions.changePreview(id, 'b', command);
        if (!shown || 'reason' in shown) throw new Error('見られない');
        return run({ ...command, seen: { throughSeq: shown.throughSeq, changes: shown.seen } });
      };
      const requestIds: string[] = [];
      for (const [n, { deadline, what = '手続き', ...extra }] of needs.entries()) {
        let view = await previewed({
          type: 'stateNeed',
          text: `${n + 1}つ目の手続き。`,
          interpretation: { what, shape: 'by', deadline, ...extra },
        });
        const known = new Set(view.plan.arrangements.map((a) => a.key));
        const requirement = view.plan.requirements.find(
          (r) => r.kind === 'need' && r.live && !requestIds.includes(r.key),
        );
        const itemId = view.plan.requirements
          .filter((r) => r.kind === 'need' && r.live)
          .map((r) => r.basis.itemIds[0])
          .at(-1);
        if (!requirement || !itemId) throw new Error('「すること」が無い');
        view = await previewed({ type: 'setNeedWays', itemId, wayIds: ['way-grandma'] });
        const arrangement = view.plan.arrangements.find(
          (a) => a.kind === 'need' && a.live && a.requirementKey.endsWith(itemId),
        );
        const option = arrangement?.options[0];
        if (!arrangement || !option) throw new Error('案が無い');
        void known;
        view = await run({
          type: 'chooseOption',
          arrangementKey: arrangement.key,
          optionKey: option.key,
          role: 'primary',
          assigneeId: 'b',
        });
        const ask = view.plan.tasks.find((t) => t.basis.optionKey === option.key && t.external);
        const shown = ask && proposalSnapshot(ask);
        if (!ask || !shown) throw new Error('頼む作業が無い');
        await run({ type: 'accept', taskKey: ask.key, shown });
        const requestId = `r-${n + 1}`;
        await run({ type: 'recordSent', taskKey: ask.key, requestId });
        requestIds.push(requestId);
      }
      const view = (await sessions.view(id, 'b')) as View;
      const base = await ctxOf('chase', 'b');
      const ctx: Ctx = {
        ...base,
        plan: view.plan,
        household: view.household,
        today: view.today,
        items: view.items,
        sources: new Map(view.sources.map((s) => [s.id, s])),
        now: view.now,
      };
      const yes = (requestId: string, over: Partial<Ctx> = {}) =>
        render(
          { ...ctx, ...over },
          {
            kind: 'change',
            proposals: [{ id: 'p1', command: { type: 'recordReply', requestId, reply: 'yes' } }],
          },
        );
      return { ctx, yes };
    }

    it('締切の違う頼み事は、送った時の締切で見分け、記録できる', async () => {
      const { yes } = await twoAsked([
        { deadline: '2026-12-03T17:00+09:00' },
        { deadline: '2026-12-04T17:00+09:00' },
      ]);
      const first = yes('r-1');
      expect(first).toContain('12/3（木） 17:00まで');
      expect(first).not.toContain('12/4');
      expect(first).toContain('記録する');
      expect(yes('r-2')).toContain('12/4（金） 17:00まで');
    }, 30_000);

    it('記録の候補には、送った時の控えの全部（手順・締切・場所・だれの分）を添える', async () => {
      const { yes } = await twoAsked([
        { deadline: '2026-12-04T17:00+09:00', place: '地区センター', forMemberId: 'c' },
      ]);
      const shown = yes('r-1');
      expect(shown).toContain('12/4（金） 17:00');
      expect(shown).toContain('祖母に来てもらえるか聞く');
      expect(shown).toContain('場所：地区センター');
      expect(shown).toContain('だれの分：陽菜');
      expect(shown).toContain('記録する');
    }, 30_000);

    it('場所だけが違う頼み事は、添えた控えで見分けて記録できる', async () => {
      const { yes } = await twoAsked([
        { deadline: '2026-12-04T17:00+09:00', place: '地区センター' },
        { deadline: '2026-12-04T17:00+09:00', place: '学童' },
      ]);
      const first = yes('r-1');
      expect(first).toContain('場所：地区センター');
      expect(first).not.toContain('どれに記録するか見分けられません');
      expect(first).toContain('記録する');
    }, 30_000);

    it('サーバーが記録させないとした候補は、送った時の控えは見せ、記録の手を出さずに訳を書く', async () => {
      const { ctx } = await twoAsked([{ deadline: '2026-12-03T17:00+09:00' }]);
      const shown = (blocked: 'needOnCard' | 'otherRequests') =>
        render(ctx, {
          kind: 'change',
          proposals: [
            { id: 'p1', command: { type: 'recordReply', requestId: 'r-1', reply: 'yes' }, blocked },
          ],
        });
      const need = shown('needOnCard');
      expect(need).toContain('試しの家庭では一言で記録しません');
      expect(need).toContain('12/3（木） 17:00まで');
      expect(need).not.toContain('記録する ');
      expect(shown('otherRequests')).toContain('ほかにも頼み事があるので、一言では記録しません');
    }, 30_000);
  });

  it('作業・未定の値も、サーバーが記録させないとした候補には訳を書き、記録の手を出さない', async () => {
    const ctx = await ctxOf('chase', 'b');
    const task = ctx.plan.tasks.find((t) => t.live);
    if (!task) throw new Error('作業が無い');
    const done = render(ctx, {
      kind: 'change',
      proposals: [
        {
          id: 'p1',
          command: { type: 'commitment', taskKey: task.key, action: 'done' },
          blocked: 'otherTasks',
        },
      ],
    });
    expect(done).toContain('ほかにも作業があるので、一言では記録しません');
    expect(done).not.toContain('記録する ');
    const answer = (blocked?: 'otherUnknowns') =>
      render(ctx, {
        kind: 'change',
        proposals: [
          {
            id: 'p1',
            command: { type: 'answer', unknownId: 'n1:u1', value: '2026-12-05' },
            label: '開催日',
            ...(blocked ? { blocked } : {}),
          },
        ],
      });
    expect(answer()).toContain('記録する ');
    expect(answer('otherUnknowns')).toContain('ほかにも答えられる問いがあるので');
    expect(answer('otherUnknowns')).not.toContain('記録する ');
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

  it('仮の話は、頼み事を控えで見せ、押すと「断られたら？」の画面へ行く（記録の手を出さない）', async () => {
    const ctx = await ctxOf('chase', 'b');
    const shown = render(ctx, { kind: 'whatIf', requestIds: ['r-grandma'] });
    expect(shown).toContain('仮の話として読みました。ここでは何も記録しません。');
    expect(shown).toContain('おばあちゃんへの頼み事（振替休業日・12/7（月） 8:10–18:15の分）');
    expect(shown).toContain('断られたら、と仮に計算する');
    expect(shown).not.toContain('記録する');
    const went: unknown[] = [];
    const sent: unknown[] = [];
    const tree = SayWhatIf({
      ctx: {
        ...ctx,
        go: (route) => went.push(route),
        send: async (command) => {
          sent.push(command);
          return { status: 'ok' };
        },
      },
      requestIds: ['r-grandma'],
      onClear: () => {},
    });
    expect(clickText(tree, '断られたら、と仮に計算する')).toBe(true);
    expect(went).toEqual([{ name: 'whatIf', requestId: 'r-grandma' }]);
    expect(sent).toEqual([]);
    const en = render(await ctxOf('chase', 'b', 'en'), {
      kind: 'whatIf',
      requestIds: ['r-grandma'],
    });
    expect(en).toContain('Calculate as if they said no');
  });

  it('仮の話で、返事を待っていない・要らなくなった頼み事は出さず、無ければそう示す', async () => {
    // 延期の後：祖母と学童の頼み事は、要らなくなって取り消しを伝える物。
    const ctx = await ctxOf('postponed', 'b');
    const none = render(ctx, { kind: 'whatIf', requestIds: ['r-grandma', 'r-gakudo', 'r-none'] });
    expect(none).toContain('今、返事を待っている頼み事が見つかりませんでした。');
    expect(none).not.toContain('仮に計算する');
    const unclear = render(ctx, { kind: 'unsupported', reason: 'replyOrWhatIf' });
    expect(unclear).toContain('本当の返事か、仮の話か分かりませんでした。');
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
    // 最初の画面では要の一文だけを見せ、送る物の全文は開くと読める（札を押し下げない）。
    // たたんでも、一言のほかに名前・今の予定・頼み事も送ると見える（押す前に分かる）。
    expect(markup).toMatch(
      /<summary[^>]*>一言と、家族・頼める人の名前、今の予定・頼み事が Anthropic に送られます。/,
    );
    expect(markup).toMatch(/<\/summary><p[^>]*>一言と、このデモの家族/);
  });
});
