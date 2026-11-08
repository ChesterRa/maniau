// 決める画面の札：決まりで選んだお勧めと理由、選べる手が消えるまでの時計、選んだら何が起きるか（サーバーが
// 同じ計算で出した「選んだら」を文にする）、選んだ後も替えられること。
import type { ChoicePreview } from '@maniau/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { demoEvents } from '../../server/src/demo';
import { previewChoices } from '../../server/src/preview';
import { ChoiceClock } from '../src/choice-clock';
import { type Ctx, DecideScreen, deadlineHolder, previewLines } from '../src/screens';
import { ctxFor } from './ctx';

const care = 'arr:childCare:n1:i6:c';
const text = (html: string) => html.replace(/<[^>]+>/g, ' ');

describe('決める画面の札', () => {
  it('まだ選んでいない時、お勧めと理由、時計、替えられることを出す', () => {
    const ctx = ctxFor('arrived', 'b', 'ja');
    const arrangement = ctx.plan.arrangements.find((a) => a.key === care);
    expect(arrangement?.recommendedOptionKey).toBeDefined();
    expect(arrangement?.recommendedReason).toBeDefined();
    const shown = text(renderToStaticMarkup(<DecideScreen ctx={ctx} arrangementKey={care} />));
    expect(shown).toContain('おすすめ');
    expect(shown).toContain(ctx.t(`decide.because.${arrangement?.recommendedReason}`));
    // おすすめは、費用だけでなく複数の負担を合わせた目安。
    expect(shown).toContain('休み・頼み事・費用・作業を合わせた負担');
    expect(shown).toContain('目安');
    expect(shown).toContain('選べる手が消えるまで');
    expect(shown).toContain('後から選び直せます');
    // 押すとその場で選ぶので、選べる手ごとに、押すと進めると書く（決め時の過ぎた手・選んだ手には書かない）。
    const choosable = (arrangement?.options ?? []).filter(
      (o) => !o.expired && o.key !== arrangement?.chosenOptionKey,
    );
    expect(choosable.length).toBeGreaterThan(0);
    expect(shown.split('これに決める').length - 1).toBe(choosable.length);
  });

  it('英語でも同じ物を出す', () => {
    const ctx = ctxFor('arrived', 'b', 'en');
    const shown = text(renderToStaticMarkup(<DecideScreen ctx={ctx} arrangementKey={care} />));
    expect(shown).toContain('Suggested');
    expect(shown).toContain('Until each choice disappears');
    expect(shown).toContain('You can change your choice later');
    expect(shown).toContain('Go with this');
  });

  it('取れる手を足す入口は、子の見守りの決める画面だけに出す（買い物の決める画面には出さない）', () => {
    const ctx = ctxFor('arrived', 'b', 'ja');
    const purchase = ctx.plan.arrangements.find((a) => a.kind === 'purchase');
    if (!purchase) throw new Error('買い物の手配が無い');
    const shop = text(
      renderToStaticMarkup(<DecideScreen ctx={ctx} arrangementKey={purchase.key} />),
    );
    expect(shop).not.toContain('取れる手を足す');
    const child = text(renderToStaticMarkup(<DecideScreen ctx={ctx} arrangementKey={care} />));
    expect(child).toContain('取れる手を足す');
  });

  it('子の見守りでは、おすすめだけを塗り、ほかは枠にする（おすすめが無ければすべて枠）', () => {
    const ctx = ctxFor('arrived', 'b', 'ja');
    const buttons = (value: Ctx) => {
      const html = renderToStaticMarkup(<DecideScreen ctx={value} arrangementKey={care} />);
      return (html.match(/<button[^>]*>/g) ?? []).filter(
        (button) => button.includes('aria-label=') && button.includes('これに決める'),
      );
    };
    const shown = buttons(ctx);
    expect(shown.length).toBeGreaterThan(1);
    expect(shown.filter((button) => button.includes(' bg-accent '))).toHaveLength(1);
    expect(shown.filter((button) => button.includes(' bg-white '))).toHaveLength(shown.length - 1);
    const withoutRecommendation = {
      ...ctx,
      plan: {
        ...ctx.plan,
        arrangements: ctx.plan.arrangements.map((a) =>
          a.key === care ? { ...a, recommendedOptionKey: undefined } : a,
        ),
      },
    } as Ctx;
    expect(buttons(withoutRecommendation).every((button) => button.includes(' bg-white '))).toBe(
      true,
    );
  });

  it('子の見守りの決め時と同じ人・同じ分の繰り返しだけを省く', () => {
    const ctx = ctxFor('arrived', 'b', 'ja');
    const arrangement = ctx.plan.arrangements.find((a) => a.key === care);
    if (!arrangement) throw new Error('手配が無い');
    const previews = previewChoices(demoEvents('arrived'), { memberId: 'b', now: ctx.now }, care);
    const school = previews?.find((p) => p.optionKey.endsWith(':opt-gakudo'));
    const leave = previews?.find((p) => p.optionKey.endsWith(':opt-leave-a'));
    if (!school?.later || !leave?.steps[0]?.start || !leave.decisionDeadline)
      throw new Error('案の見通しが無い');

    const schoolOption = arrangement.options.find((o) => o.key === school.optionKey);
    expect(schoolOption && deadlineHolder(schoolOption, school)).toBe(school.later.memberId);
    const schoolLines = previewLines(ctx, school);
    // 自分の先の時刻は残し、決め時の行と同じもう一人の時刻だけを省く。
    expect(schoolLines.some((line) => line.includes('17:05'))).toBe(true);
    expect(schoolLines.some((line) => line.includes('健太さんなら'))).toBe(false);
    const differentLater = {
      ...school,
      later: { ...school.later, start: '2026-11-30T17:21+09:00' },
    };
    expect(previewLines(ctx, differentLater).some((line) => line.includes('17:21'))).toBe(true);

    const leaveLines = previewLines(ctx, leave);
    expect(leaveLines.some((line) => line.includes('会社に休みを伝える'))).toBe(true);
    expect(leaveLines.some((line) => line.includes('17:25'))).toBe(false);
    // 人・分・選んだ後の決め時が違うか不明なら、省かない。
    const first = leave.steps[0];
    const otherPerson = {
      ...leave,
      steps: [{ ...first, assigneeId: 'b' }, ...leave.steps.slice(1)],
    };
    expect(previewLines(ctx, otherPerson).some((line) => line.includes('17:25'))).toBe(true);
    const otherDeadlineHolder = {
      ...leave,
      later: { memberId: 'b', start: leave.decisionDeadline },
    };
    expect(previewLines(ctx, otherDeadlineHolder).some((line) => line.includes('17:25'))).toBe(
      true,
    );
    const otherMinute = {
      ...leave,
      steps: [{ ...first, start: '2026-12-02T17:24+09:00' }, ...leave.steps.slice(1)],
    };
    expect(previewLines(ctx, otherMinute).some((line) => line.includes('17:24'))).toBe(true);
    const unknownAfter = { ...leave, decisionDeadline: undefined };
    expect(previewLines(ctx, unknownAfter).some((line) => line.includes('17:25'))).toBe(true);
    const needCtx = {
      ...ctx,
      plan: {
        ...ctx.plan,
        arrangements: ctx.plan.arrangements.map((a) =>
          a.key === care ? { ...a, kind: 'need', needShape: 'window' } : a,
        ),
      },
    } as Ctx;
    expect(previewLines(needCtx, leave).some((line) => line.includes('17:25'))).toBe(true);
  });

  it('「選んだら」を、最初の一手・ほかの作業の数・取り消し・動く作業の文にする', () => {
    const ctx = ctxFor('chase', 'b', 'ja');
    const write = ctx.plan.tasks.find(
      (t) => t.key === 'task:opt:arr:childCare:n1:i6:c:opt-gakudo:write',
    );
    const request = ctx.plan.requests.find((r) => r.requestId === 'r-grandma');
    if (!write?.start || !request) throw new Error('作業か依頼が無い');
    const preview: ChoicePreview = {
      arrangementKey: care,
      optionKey: 'opt:arr:childCare:n1:i6:c:opt-gakudo',
      current: false,
      steps: [
        {
          taskKey: write.key,
          titleKey: write.titleKey,
          titleParams: write.titleParams,
          assigneeId: 'b',
          start: write.start,
          external: false,
        },
        {
          taskKey: 'task:opt:arr:childCare:n1:i6:c:opt-gakudo:submit',
          titleKey: 'task.gakudo.submit',
          titleParams: {},
          external: false,
        },
      ],
      cancels: [request],
      conflicts: [],
      moved: [{ taskKey: 'x', before: {}, after: {} }],
    };
    const lines = previewLines(ctx, preview);
    expect(lines[0]).toContain('あなたが');
    expect(lines[0]).toContain('までに始める');
    expect(lines).toContain('ほかに作業が1つ');
    expect(lines.some((l) => l.includes('取り消しを伝える作業'))).toBe(true);
    expect(lines.some((l) => l.includes('重ならないように動きます'))).toBe(true);
    // 今進めている案には出さない。
    expect(previewLines(ctx, { ...preview, current: true })).toEqual([]);
    // もう一人の大人がする時は、ほかの行と同じく「さん」を付けて書く。
    const other = previewLines(ctx, {
      ...preview,
      steps: preview.steps.map((s, i) => (i === 0 ? { ...s, assigneeId: 'a' } : s)),
    });
    expect(other[0]).toContain('健太さんが「');
    expect(other[0]).not.toMatch(/健太が/);
  });

  it('重ならずに置けない時・自分の時間にもう置けない時・ほかの人なら後まで間に合う時を、そう書く', () => {
    const ctx = ctxFor('arrived', 'b', 'ja');
    const base: ChoicePreview = {
      arrangementKey: care,
      optionKey: 'opt:arr:childCare:n1:i6:c:opt-gakudo',
      current: false,
      steps: [],
      cancels: [],
      conflicts: [],
      moved: [],
    };
    // 重ならずに置けない：時刻を決めずに残すと先に書く。
    const conflict = previewLines(ctx, { ...base, conflicts: [base.optionKey] });
    expect(conflict[0]).toContain('「12/7（月）の学童に預ける」の作業に');
    expect(conflict[0]).toContain('今の計算では見つけられません');
    expect(conflict[0]).toContain('時刻を決めずに残します');
    // 自分の時間にもう置けない：置ける大人に提案すると書く。
    expect(previewLines(ctx, { ...base, assigneeId: 'a' })[0]).toContain(
      '健太さんに作業を提案します',
    );
    // 自分でするなら早い時は、後まで間に合う人と時刻を添える。
    const later = previewLines(ctx, {
      ...base,
      assigneeId: 'b',
      later: { memberId: 'a', start: '2026-11-30T17:20+09:00' },
    });
    expect(later.some((l) => l.includes('健太さんなら') && l.includes('17:20'))).toBe(true);
    const laterEn = previewLines(ctxFor('arrived', 'b', 'en'), {
      ...base,
      assigneeId: 'b',
      later: { memberId: 'a', start: '2026-11-30T17:20+09:00' },
    });
    expect(laterEn.some((l) => l.includes('健太 could still make it if they start by'))).toBe(true);
  });

  it('決め時が、後まで間に合う大人の始める最後と同じ分の時だけ、その人の名を添える（違えば添えない）', () => {
    const ctx = ctxFor('arrived', 'b', 'ja');
    const option = ctx.plan.arrangements
      .find((a) => a.key === care)
      ?.options.find((o) => o.decisionDeadline !== undefined);
    expect(option?.decisionDeadline).toBeDefined();
    if (!option?.decisionDeadline) return;
    const base: ChoicePreview = {
      arrangementKey: care,
      optionKey: option.key,
      current: false,
      steps: [],
      cancels: [],
      conflicts: [],
      moved: [],
      assigneeId: 'b',
    };
    // 同じ分（書き方の違う同じ時刻も同じ分として比べる。ここでは UTC の書き方）：その大人。
    expect(
      deadlineHolder(option, {
        ...base,
        later: { memberId: 'a', start: new Date(option.decisionDeadline).toISOString() },
      }),
    ).toBe('a');
    // 一分でも違えば、推して名を付けない。
    const shifted = new Date(new Date(option.decisionDeadline).getTime() + 60_000).toISOString();
    expect(deadlineHolder(option, { ...base, later: { memberId: 'a', start: shifted } })).toBe(
      undefined,
    );
    // 後まで間に合う人がいなければ、添えない。「選んだら」を読めていなくても、添えない。
    expect(deadlineHolder(option, base)).toBe(undefined);
    expect(deadlineHolder(option, undefined)).toBe(undefined);
    // 決め時の無い手には、添えない。
    const { decisionDeadline: _, ...noDeadline } = option;
    expect(
      deadlineHolder(noDeadline, {
        ...base,
        later: { memberId: 'a', start: option.decisionDeadline },
      }),
    ).toBe(undefined);
    // 文：目安であることと、だれがする時の決め時かを日英で書く。
    const ja = ctx.t('decide.byWho', {
      deadline: '12/1（月）17:20',
      name: ctx.t('decide.person', { name: '健太' }),
    });
    expect(ja).toContain('目安');
    expect(ja).toContain('健太さんがする時');
    const en = ctxFor('arrived', 'b', 'en');
    const enText = en.t('decide.byWho', {
      deadline: 'Mon 12/1 17:20',
      name: en.t('decide.person', { name: '健太' }),
    });
    expect(enText).toContain('estimate');
    expect(enText).toContain('if 健太 does it');
  });

  it('休みは、登録された長さのまま日英とも数に合わせて書く（日に換えない。英語で「hour(s)」と書かない）', () => {
    const ja = text(
      renderToStaticMarkup(
        <DecideScreen ctx={ctxFor('arrived', 'b', 'ja')} arrangementKey={care} />,
      ),
    );
    expect(ja).toContain('休みを8時間取ります');
    expect(ja).not.toContain('1日使います');
    const en = text(
      renderToStaticMarkup(
        <DecideScreen ctx={ctxFor('arrived', 'b', 'en')} arrangementKey={care} />,
      ),
    );
    expect(en).toContain('Time off: 8 hours');
    expect(en).not.toContain('hour(s)');
  });

  it('お勧めは一つだけ（人に頼む手の返事の期限は、その手の札に事実として書く）', () => {
    const ctx = ctxFor('arrived', 'b', 'ja');
    const shown = text(renderToStaticMarkup(<DecideScreen ctx={ctx} arrangementKey={care} />));
    expect(shown.match(/おすすめ/g)).toHaveLength(1);
    expect(shown).not.toContain('迷ったら');
    expect(shown).toMatch(/の夜までに返事をもらえれば/);
  });

  it('時計は、エンジンと同じ境目で数え、決め時の分からない手を「無い」と言わない', () => {
    const ctx = ctxFor('arrived', 'a', 'ja');
    const now = '2026-11-30T17:20+09:00';
    const clock = (options: Parameters<typeof ChoiceClock>[0]['options']) =>
      text(
        renderToStaticMarkup(
          <ChoiceClock
            t={ctx.t}
            lang="ja"
            tz="Asia/Tokyo"
            now={now}
            until="2026-12-07T08:10+09:00"
            options={options}
          />,
        ),
      );
    // 決め時のちょうどその時は、まだ選べる（過ぎたのは、決め時より後）。
    const atDeadline = clock([{ key: 's', title: '学童', deadline: now, expired: false }]);
    expect(atDeadline).toContain('いま選べる手は1つ');
    expect(atDeadline).not.toContain('もうありません。');
    // 決め時の分からない手だけ：分からないと書く（無いとは言わない）。
    const unknown = clock([{ key: 's', title: '学童', expired: false }]);
    expect(unknown).toContain('決め時の分からない手が1つあります');
    expect(unknown).not.toContain('決め時の過ぎていない手は、もうありません');
    // 全部過ぎていれば、無いと書く。
    const gone = clock([
      { key: 's', title: '学童', deadline: '2026-11-30T17:00+09:00', expired: true },
    ]);
    expect(gone).toContain('決め時の過ぎていない手は、もうありません');
  });

  it('「選んだら」を読める画面では、読み終えるまで手を選べない（読んでいると書く）', () => {
    const ctx = { ...ctxFor('chase', 'b', 'ja'), preview: () => new Promise<never>(() => {}) };
    const html = renderToStaticMarkup(<DecideScreen ctx={ctx} arrangementKey={care} />);
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    const options = ctx.plan.arrangements.find((a) => a.key === care)?.options ?? [];
    expect(buttons.filter((b) => b.includes('disabled')).length).toBeGreaterThanOrEqual(
      options.length,
    );
    expect(text(html)).toContain('計算しています');
    // 選ぶボタンは見せるが、読み終えるまではすべて押せない。
    const actions = buttons.filter((b) => b.includes('aria-label=') && b.includes('これに決める'));
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((b) => b.includes('disabled'))).toBe(true);
  });

  it('条件しだいの手配は、決める画面でもそう書く', () => {
    const ctx = ctxFor('arrived', 'b', 'ja');
    expect(ctx.plan.arrangements.find((a) => a.key === care)?.conditional).toBe(true);
    const shown = text(renderToStaticMarkup(<DecideScreen ctx={ctx} arrangementKey={care} />));
    expect(shown).toContain('まだ決まっていません');
  });

  it('選ぶと今の計画に見つからなくなるだけの引き受けは、要らなくなるとは言わず、確かめてもらうと書く', () => {
    const ctx = ctxFor('arrived', 'b', 'ja');
    const content = { titleKey: 'task.gakudoForm.write', titleParams: {} };
    const lines = previewLines(ctx, {
      arrangementKey: care,
      optionKey: 'opt:arr:childCare:n1:i6:c:opt-gakudo',
      current: false,
      steps: [],
      cancels: [],
      conflicts: [],
      moved: [],
      released: [
        { taskKey: 't1', assigneeId: 'a', content, reason: 'unconfirmed' },
        { taskKey: 't2', assigneeId: 'b', content, reason: 'unconfirmed' },
        { taskKey: 't3', assigneeId: 'a', content, reason: 'gone' },
      ],
    });
    expect(lines).toContain(
      '健太さんが引き受けていた「学童の申込書を書く」が、今の計画に見つからなくなります（まだ要るか、確かめてもらいます）',
    );
    expect(lines).toContain(
      'あなたが引き受けていた「学童の申込書を書く」が、今の計画に見つからなくなります（まだ要るか、確かめてください）',
    );
    expect(lines).toContain(
      '健太さんが引き受けていた「学童の申込書を書く」は要らなくなります（知らせます）',
    );
  });
});
