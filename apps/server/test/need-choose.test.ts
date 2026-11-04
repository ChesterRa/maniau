// 通用の「すること」で、画面と同じ道で本命を選ぶ：「選んだら」（previewChoices）を見てから、見せた要約を付けて
// 選ぶ（子の居場所の決める画面と同じ選ぶ所）。一言で「頼んだ」「済ませた」と伝えた時は、画面の「送った」
// 「済んだ」と同じ物を候補の命令に付ける（窓の「すること」の時間、作業の今の用件）。デモの家庭にはほかにも作業が
// あるので、一言では記録せず（取り違えないため）、同じ命令を札で記録する。架空のデモ・偽の読み取り（API は
// 呼ばない）。
import type { PreviewCommand, Task } from '@maniau/core';
import { expect, it } from 'vitest';
import { demoSessions, type UtteranceReader } from '../src/demo-sessions';

/** デモの家（11/25 19:31）で、彩（b）が「すること」を足し、やり方を選び、「選んだら」を見て本命を選ぶ。 */
async function chosen(
  interpretation: Record<string, unknown>,
  text: string,
  wayIds: string[],
  wayId: string,
) {
  const sessions = demoSessions();
  const id = sessions.create('arrived');
  let n = 0;
  const write = async (command: PreviewCommand) => {
    const shown = await sessions.changePreview(id, 'b', command);
    if (!shown || 'reason' in shown) throw new Error('変わることを見られない');
    const done = await sessions.command(id, 'b', `w-${++n}`, {
      ...command,
      seen: { throughSeq: shown.throughSeq, changes: shown.seen },
    });
    expect(done?.result.status).toBe('ok');
  };
  await write({ type: 'stateNeed', text, interpretation } as PreviewCommand);
  let view = await sessions.view(id, 'b');
  const itemId = view?.plan.requirements.find((r) => r.kind === 'need' && r.live)?.basis.itemIds[0];
  if (!itemId) throw new Error('「すること」が無い');
  await write({ type: 'setNeedWays', itemId, wayIds });
  view = await sessions.view(id, 'b');
  const arrangement = view?.plan.arrangements.find((a) => a.kind === 'need' && a.live);
  if (!arrangement) throw new Error('手配が無い');

  // 画面の選ぶ所が読む「選んだら」が、どの案にもある（前は子の居場所の手配だけで、選べなかった）。
  const previews = await sessions.preview(id, 'b', arrangement.key);
  expect(previews?.map((p) => p.optionKey).sort()).toEqual(
    arrangement.options.map((o) => o.key).sort(),
  );
  const option = arrangement.options.find((o) => o.templateId === wayId);
  const shown = previews?.find((p) => p.optionKey === option?.key);
  if (!option || !shown?.seen) throw new Error('「選んだら」が無い');
  const result = await sessions.command(id, 'b', 'choose', {
    type: 'chooseOption',
    arrangementKey: arrangement.key,
    optionKey: option.key,
    role: 'primary',
    assigneeId: shown.assigneeId,
    seen: shown.seen,
  });
  expect(result?.result.status).toBe('ok');
  view = await sessions.view(id, 'b');
  expect(view?.plan.arrangements.find((a) => a.key === arrangement.key)?.chosenOptionKey).toBe(
    option.key,
  );
  const task = view?.plan.tasks.find((t) => t.live && t.basis.optionKey === option.key);
  if (!task?.assigneeId) throw new Error('本命の作業が無い');
  return { sessions, id, arrangement, task };
}

/**
 * 作業の担当が一言で伝え、候補を確かめる（偽の読み取りが、その作業への一つの動きを返す）。ほかにも作業があるので
 * 一言では記録せず、候補の命令を札で記録する。
 */
async function said(
  { sessions, id }: { sessions: ReturnType<typeof demoSessions>; id: string },
  task: Task,
  type: 'recordSent' | 'done',
  text: string,
) {
  const reader: UtteranceReader = async () => ({
    output: {
      kind: 'change',
      actions: [
        { type, taskKey: task.key, requestId: null, reply: null, unknownId: null, value: null },
      ],
      refs: { taskKeys: [task.key], requestIds: [], itemIds: [] },
      unsupported: null,
    },
    model: 'fixture',
    promptVersion: 'fixture',
    inputHash: 'fixture',
    usage: { input_tokens: 0, output_tokens: 0 },
  });
  const who = task.assigneeId ?? '';
  const heard = await sessions.utterance(id, who, { text, operationId: `hear-${type}` }, reader);
  if (heard?.status !== 'ok' || heard.reply.kind !== 'change') throw new Error('候補が無い');
  const proposal = heard.reply.proposals[0];
  if (!proposal) throw new Error('候補が無い');
  expect(proposal.blocked).toBe('otherTasks');
  expect((await sessions.confirm(id, who, proposal.id, 'confirm'))?.status).toBe('changed');
  const card = await sessions.command(id, who, `card-${type}`, proposal.command);
  expect(card?.result.status).toBe('ok');
  return sessions.view(id, who);
}

it('「すること」の本命を「選んだら」を見てから選び、一言の「頼んだ」の候補に窓を付ける', async () => {
  const setup = await chosen(
    {
      what: '陽菜を家で見る',
      shape: 'window',
      date: '2026-11-26',
      startTime: '08:00',
      endTime: '18:00',
      forMemberId: 'c',
    },
    '陽菜が熱っぽいので、あしたは8時から18時まで、だれか家にいてほしい',
    ['way-sick-care', 'way-grandma'],
    'way-grandma',
  );
  // 頼む作業を持つ人が、一言で「頼んだ」と伝える。
  const view = await said(setup, setup.task, 'recordSent', 'おばあちゃんに、あしたのことを頼んだ');
  expect(view?.plan.requests.find((r) => r.taskKey === setup.task.key)?.window).toEqual({
    start: setup.arrangement.start,
    end: setup.arrangement.end,
  });
});

it('「すること」の作業の一言の「済ませた」の候補は、札で記録すると済みになる（用件は中身とやり方の版まで、画面と同じ）', async () => {
  const setup = await chosen(
    { what: '学童クラブの継続を申し込む', shape: 'by', deadline: '2026-12-04T17:00+09:00' },
    '12月4日の17時までに、学童クラブの継続を申し込む',
    ['way-apply-online'],
    'way-apply-online',
  );
  // 「すること」の作業は、中身とやり方の版（about）を持つ。前は一言の命令に付けず、今の用件と違うと断られた。
  expect(setup.task.about).toBeDefined();
  const view = await said(setup, setup.task, 'done', '学童の継続、ホームページで申し込んだ');
  expect(view?.plan.tasks.find((t) => t.key === setup.task.key)?.commitment).toBe('done');
});
