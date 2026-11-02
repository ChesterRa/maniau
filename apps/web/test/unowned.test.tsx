// 担当のいない作業：自分で持った予備の手順に置ける時間が無い時、その場でもう一人に頼める。断ったら、
// 二人の「きょう」に「だれがやるか、決まっていません」と出し、持つ・頼む・予備をやめるを選べる。
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { demoSessions } from '../../server/src/demo-sessions';
import type { View } from '../../server/src/views';
import i18n from '../src/i18n';
import { type Ctx, TodayScreen } from '../src/screens';
import { demoData } from './ctx';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

function ctxOf(view: View, memberId: string): Ctx {
  const me = view.household.members.find((m) => m.id === memberId);
  if (!me) throw new Error(`大人が無い：${memberId}`);
  return {
    plan: view.plan,
    household: view.household,
    today: view.today,
    items: view.items,
    sources: new Map(view.sources.map((s) => [s.id, s])),
    readings: demoData.readings,
    me,
    lang: 'ja',
    tz: view.household.timeZone,
    now: view.now,
    t: i18n.getFixedT('ja'),
    outbound: (lng) => i18n.getFixedT(lng),
    send: async () => ({ status: 'ok' }),
    go: () => {},
  };
}

describe('担当のいない作業', () => {
  it('置けない手順はその場で頼め、断ったら二人に出す（断った人には頼み直さない）', async () => {
    const sessions = demoSessions();
    const id = sessions.create('chase');
    let op = 0;
    const run = async (memberId: string, command: Parameters<typeof sessions.command>[3]) => {
      const done = await sessions.command(id, memberId, `op-${++op}`, command);
      expect(done?.result.status).toBe('ok');
    };
    const view = async (memberId: string) => {
      const shown = await sessions.view(id, memberId);
      if (!shown) throw new Error('見せる物が無い');
      return shown;
    };
    const screen = async (memberId: string) =>
      text(renderToStaticMarkup(<TodayScreen ctx={ctxOf(await view(memberId), memberId)} />));

    const backup = (await view('b')).today.main.find((c) => c.kind === 'backup');
    if (backup?.kind !== 'backup') throw new Error('予備の札が無い');
    await run('b', {
      type: 'chooseOption',
      arrangementKey: backup.arrangement.key,
      optionKey: backup.option.key,
      role: 'backup',
      assigneeId: 'b',
    });
    // 彩のふだんの予定では置けない：断る前に、健太に頼める。
    const placed = await screen('b');
    expect(placed).toContain('決め時までに置ける時間がありません');
    expect(placed).toContain('健太さんに頼む');

    for (const card of (await view('b')).today.main) {
      if (card.kind === 'proposal') {
        await run('b', { type: 'commitment', taskKey: card.task.key, action: 'decline' });
      }
    }
    const aya = await screen('b');
    expect(aya.match(/だれがやるか、決まっていません/g)).toHaveLength(2);
    expect(aya).toContain('彩さんは、できないと答えました');
    expect(aya).toContain('健太さんに頼む');
    expect(aya).toContain('この予備はやめる');
    const kenta = await screen('a');
    expect(kenta.match(/だれがやるか、決まっていません/g)).toHaveLength(2);
    expect(kenta).toContain('自分でやる');
    expect(kenta).not.toContain('彩さんに頼む');
  });

  it('勧めただけの買い物を断った時は、持つ・頼むは出すが、選んでいない案をやめる道は出さない', async () => {
    const sessions = demoSessions();
    const id = sessions.create('asked');
    const kentaView = await sessions.view(id, 'a');
    const buy = kentaView?.today.main.find((c) => c.kind === 'proposal');
    if (buy?.kind !== 'proposal') throw new Error('買い物の提案が無い');
    const done = await sessions.command(id, 'a', 'op-1', {
      type: 'commitment',
      taskKey: buy.task.key,
      action: 'decline',
    });
    expect(done?.result.status).toBe('ok');
    const shown = await sessions.view(id, 'b');
    if (!shown) throw new Error('見せる物が無い');
    const aya = text(renderToStaticMarkup(<TodayScreen ctx={ctxOf(shown, 'b')} />));
    expect(aya).toContain('だれがやるか、決まっていません');
    expect(aya).toContain('自分でやる');
    expect(aya).not.toContain('この案はやめる');
    expect(aya).not.toContain('この予備はやめる');
  });

  it('本人しかできない手順（自分の有休の申請）は、ほかの人に持たせず、案をやめる道を出す', async () => {
    const sessions = demoSessions();
    const id = sessions.create('arrived');
    let op = 0;
    const run = async (memberId: string, command: Parameters<typeof sessions.command>[3]) => {
      const done = await sessions.command(id, memberId, `op-${++op}`, command);
      expect(done?.result.status).toBe('ok');
    };
    const screen = async (memberId: string) => {
      const shown = await sessions.view(id, memberId);
      if (!shown) throw new Error('見せる物が無い');
      return text(renderToStaticMarkup(<TodayScreen ctx={ctxOf(shown, memberId)} />));
    };
    const care = 'arr:childCare:n1:i6:c';
    const leave = `opt:${care}:opt-leave-a`;
    await run('a', {
      type: 'chooseOption',
      arrangementKey: care,
      optionKey: leave,
      role: 'primary',
      assigneeId: 'a',
    });
    await run('a', { type: 'commitment', taskKey: `task:${leave}:apply`, action: 'decline' });
    const aya = await screen('b');
    expect(aya).toContain('だれがやるか、決まっていません');
    expect(aya).toContain('この手順は、健太さんしかできません');
    expect(aya).not.toContain('自分でやる');
    expect(aya).not.toContain('健太さんに頼む');
    expect(aya).toContain('この案はやめる');
    const kenta = await screen('a');
    expect(kenta).toContain('自分でやる');
    expect(kenta).not.toContain('彩さんに頼む');
  });
});
