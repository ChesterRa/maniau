// 予備を押さえる札の押し口：サーバーと同じ決まりで、手順ごとの本当の担当に合わせる。本人しかできない手順
// （自分の休みの申請など）はその人に頼むので、押し口の人と実際に頼む人を食い違わせない。架空のデモの家。
import type { Command } from '@maniau/core';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BackupCard, type Ctx } from '../src/screens';
import { ctxFor } from './ctx';

const care = 'arr:childCare:n1:i6:c';
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

/** 要素の木から、その文字の押し口を探して押す（フックの無い部品を、DOM なしで押す）。 */
function press(node: ReactNode, label: string): boolean {
  if (Array.isArray(node)) return node.some((n) => press(n, label));
  if (!node || typeof node !== 'object' || !('props' in node)) return false;
  const el = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
  if (el.props.children === label && el.props.onClick) {
    el.props.onClick();
    return true;
  }
  return press(el.props.children, label);
}

function card(ctx: Ctx, templateId: string) {
  const sent: Command[] = [];
  const at = {
    ...ctx,
    send: async (command: Command) => {
      sent.push(command);
      return { status: 'ok' };
    },
  };
  const arrangement = at.plan.arrangements.find((a) => a.key === care);
  const option = arrangement?.options.find((o) => o.key.endsWith(`:${templateId}`));
  if (!arrangement || !option) throw new Error(`案が無い：${templateId}`);
  const props = { ctx: at as Ctx, arrangement, option };
  return {
    shown: text(renderToStaticMarkup(<BackupCard {...props} />)),
    press: (label: string) => {
      if (!press(BackupCard(props), label)) throw new Error(`押す物が無い：${label}`);
      return sent.at(-1);
    },
  };
}

/** 家の情報で、学童の手順の担当を決めておく（本人しかできない手順にする）。 */
function fixing(ctx: Ctx, assignees: Record<string, string>): Ctx {
  return {
    ...ctx,
    household: {
      ...ctx.household,
      careOptions: ctx.household.careOptions.map((o) =>
        o.id === 'opt-gakudo'
          ? {
              ...o,
              steps: o.steps.map((s) =>
                assignees[s.id] ? { ...s, assigneeId: assignees[s.id] } : s,
              ),
            }
          : o,
      ),
    },
  };
}

describe('予備を押さえる札の押し口', () => {
  it('だれでもできる手順だけなら、もう一人に頼む・自分でやるの二つ', () => {
    const c = card(ctxFor('chase', 'b', 'ja'), 'opt-gakudo');
    expect(c.shown).toContain('健太さんに頼む');
    expect(c.shown).toContain('自分でやる');
    expect(c.shown).not.toContain('しかできない');
    expect(c.press('健太さんに頼む')).toMatchObject({ type: 'chooseOption', assigneeId: 'a' });
    expect(c.press('自分でやる')).toMatchObject({ type: 'chooseOption', assigneeId: 'b' });
  });

  it('全部の手順がもう一人にしかできない（健太さんが休む）なら、その人に頼む押し口だけ（日英）', () => {
    const ja = card(ctxFor('chase', 'b', 'ja'), 'opt-leave-a');
    expect(ja.shown).toContain('健太さんに頼む');
    expect(ja.shown).not.toContain('自分でやる');
    expect(ja.press('健太さんに頼む')).toMatchObject({ role: 'backup', assigneeId: 'a' });
    const en = card(ctxFor('chase', 'b', 'en'), 'opt-leave-a');
    expect(en.shown).toContain('Ask 健太');
    expect(en.shown).not.toContain('I&#x27;ll do it');
    expect(en.shown).not.toContain("I'll do it");
  });

  it('全部の手順が自分にしかできない（彩さんが休む）なら、自分でやるだけ', () => {
    const c = card(ctxFor('chase', 'b', 'ja'), 'opt-leave-b');
    expect(c.shown).toContain('自分でやる');
    expect(c.shown).not.toContain('健太さんに頼む');
    expect(c.press('自分でやる')).toMatchObject({ assigneeId: 'b' });
  });

  it('本人しかできない手順と、だれでもできる手順が混ざれば、二つの押し口に、決まった手順の担当を書き添える', () => {
    const c = card(fixing(ctxFor('chase', 'b', 'ja'), { write: 'a' }), 'opt-gakudo');
    expect(c.shown).toContain('健太さんに頼む');
    expect(c.shown).toContain('自分でやる');
    expect(c.shown).toMatch(
      /「学童の申込書を書く[^」]*」は健太さんしかできないので、健太さんに頼みます。/,
    );
  });

  it('手順が何人かに分かれて決まっていれば、だれに頼むかは選ばせず、押さえるだけにし、手順ごとの担当を書く', () => {
    const c = card(fixing(ctxFor('chase', 'b', 'ja'), { write: 'a', submit: 'b' }), 'opt-gakudo');
    expect(c.shown).toContain('予備に押さえる');
    expect(c.shown).not.toContain('健太さんに頼む');
    expect(c.shown).not.toContain('自分でやる');
    expect(c.shown).toMatch(/「学童の申込書を書く[^」]*」は健太さんしかできないので/);
    expect(c.shown).toMatch(
      /「学童に申込書を出す[^」]*」はあなたしかできないので、あなたの作業になります。/,
    );
    expect(c.press('予備に押さえる')).toMatchObject({ type: 'chooseOption', role: 'backup' });
  });
});
