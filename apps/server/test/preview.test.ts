// 決める画面の「選んだら」（架空のデモ）。選ぶ命令を書き込まずに同じ計算をし、案ごとに、出る作業・取り消し
// を伝える依頼・時刻の動く作業を返す。何も書かない。
import { keys } from '@maniau/core/engine';
import { expect, it } from 'vitest';
import { demoSessions } from '../src/demo-sessions';

const care = 'arr:childCare:n1:i6:c';
const grandma = keys.option(care, 'opt-grandma');
const gakudo = keys.option(care, 'opt-gakudo');

it('まだ選んでいない時、案ごとに選んだら出る作業を返し、何も書かない', async () => {
  const sessions = demoSessions();
  const id = sessions.create('arrived');
  const before = await sessions.view(id, 'b');
  const previews = await sessions.preview(id, 'b', care);
  if (!previews) throw new Error('「選んだら」が無い');
  const byOption = new Map(previews.map((p) => [p.optionKey, p]));
  // 学童：申込書を書いて出す作業を、選んだ本人（b）が持つ。決め時もある。
  const school = byOption.get(gakudo);
  expect(school?.current).toBe(false);
  expect(school?.steps.length).toBeGreaterThan(0);
  expect(school?.steps.every((s) => s.assigneeId === 'b')).toBe(true);
  expect(school?.decisionDeadline).toBeDefined();
  expect(school?.cancels).toEqual([]);
  // 祖母：頼む作業は外の相手への物。
  expect(byOption.get(grandma)?.steps.some((s) => s.external)).toBe(true);
  // 何も書いていない（計画の事象の位置が同じ）。
  const after = await sessions.view(id, 'b');
  expect(after?.plan.throughSeq).toBe(before?.plan.throughSeq);
});

it('頼んだ後に別の案へ替えるなら、取り消しを伝える依頼を返す', async () => {
  const sessions = demoSessions();
  const id = sessions.create('chase');
  const previews = await sessions.preview(id, 'b', care);
  if (!previews) throw new Error('「選んだら」が無い');
  expect(previews.find((p) => p.optionKey === grandma)?.current).toBe(true);
  expect(previews.find((p) => p.optionKey === gakudo)?.cancels.map((r) => r.requestId)).toContain(
    'r-grandma',
  );
});

it('子の居場所の手配でなければ返さない', async () => {
  const sessions = demoSessions();
  const id = sessions.create('arrived');
  expect(await sessions.preview(id, 'b', 'arr:none')).toBeUndefined();
  expect(await sessions.preview('no-such-session', 'b', care)).toBeNull();
});

it('今の本命も同じ命令を通して見る（別の大人が選び直せば担当が替わるので、何も変わらないとは言わない）', async () => {
  const sessions = demoSessions();
  const id = sessions.create('arrived');
  const chose = await sessions.command(id, 'b', 'choose-grandma', {
    type: 'chooseOption',
    arrangementKey: care,
    optionKey: grandma,
    role: 'primary',
    assigneeId: 'b',
  });
  expect(chose?.result.status).toBe('ok');
  const previews = await sessions.preview(id, 'a', care);
  const current = previews?.find((p) => p.optionKey === grandma);
  // 選び直すと担当が a に替わるので、「何も変わらない」とは言わない。
  expect(current?.current).toBe(false);
  expect(current?.steps.length).toBeGreaterThan(0);
  expect(current?.steps.every((s) => s.assigneeId === 'a')).toBe(true);
  // 選んだ本人（b）が見れば、選び直しても何も変わらない。
  expect(
    (await sessions.preview(id, 'b', care))?.find((p) => p.optionKey === grandma)?.current,
  ).toBe(true);
});

it('見せた後に後始末が増えていたら、選ぶ命令を断り、見せ直した物なら受ける', async () => {
  const sessions = demoSessions();
  const id = sessions.create('arrived');
  const seen = (await sessions.preview(id, 'a', care))?.find((p) => p.optionKey === gakudo);
  expect(seen?.cancels).toEqual([]);
  expect(seen?.seen).toBeDefined();
  // a が見た後で、b が祖母を選び、頼んだと記録する。
  expect(
    (
      await sessions.command(id, 'b', 'b-choose', {
        type: 'chooseOption',
        arrangementKey: care,
        optionKey: grandma,
        role: 'primary',
        assigneeId: 'b',
      })
    )?.result.status,
  ).toBe('ok');
  const arrangement = (await sessions.view(id, 'b'))?.plan.arrangements.find((a) => a.key === care);
  if (!arrangement) throw new Error('手配が無い');
  expect(
    (
      await sessions.command(id, 'b', 'b-sent', {
        type: 'recordSent',
        taskKey: keys.task(grandma, 'ask'),
        requestId: 'r-b',
        window: { start: arrangement.start, end: arrangement.end },
      })
    )?.result.status,
  ).toBe('ok');
  const choose = (operationId: string, shown: string | undefined) =>
    sessions.command(id, 'a', operationId, {
      type: 'chooseOption',
      arrangementKey: care,
      optionKey: gakudo,
      role: 'primary',
      assigneeId: 'a',
      ...(shown === undefined ? {} : { seen: shown }),
    });
  expect((await choose('a-stale', seen?.seen))?.result).toMatchObject({
    status: 'conflict',
    reason: 'consequencesChanged',
  });
  const again = (await sessions.preview(id, 'a', care))?.find((p) => p.optionKey === gakudo);
  expect(again?.cancels.map((r) => r.requestId)).toEqual(['r-b']);
  expect((await choose('a-again', again?.seen))?.result.status).toBe('ok');
});

it('見せた後に事項の日が直されていたら、取り消しが同じでも断る（見せた日と違う作業を置かない）', async () => {
  const sessions = demoSessions();
  const id = sessions.create('arrived');
  const seen = (await sessions.preview(id, 'a', care))?.find((p) => p.optionKey === gakudo);
  expect(seen?.steps[0]?.titleParams.date).toBe('2026-12-07');
  expect(seen?.cancels).toEqual([]);
  const correction = {
    type: 'correctItem',
    itemId: 'n1:i6',
    interpretation: { date: '2026-12-14', writtenWeekday: 1 },
  } as const;
  const correctionPreview = await sessions.changePreview(id, 'b', correction);
  if (!correctionPreview || 'status' in correctionPreview) throw Error('直しの変化を見られない');
  const fixed = await sessions.command(id, 'b', 'fix', {
    ...correction,
    seen: { throughSeq: correctionPreview.throughSeq, changes: correctionPreview.seen },
  });
  expect(fixed?.result.status).toBe('ok');
  const choose = (operationId: string, shown: string | undefined) =>
    sessions.command(id, 'a', operationId, {
      type: 'chooseOption',
      arrangementKey: care,
      optionKey: gakudo,
      role: 'primary',
      assigneeId: 'a',
      ...(shown === undefined ? {} : { seen: shown }),
    });
  expect((await choose('old', seen?.seen))?.result).toMatchObject({
    status: 'conflict',
    reason: 'consequencesChanged',
  });
  const fresh = (await sessions.preview(id, 'a', care))?.find((p) => p.optionKey === gakudo);
  expect(fresh?.steps[0]?.titleParams.date).toBe('2026-12-14');
  const chose = await choose('fresh', fresh?.seen);
  expect(chose?.result.status).toBe('ok');
  expect(
    chose?.view.plan.tasks
      .filter((t) => t.basis.optionKey === gakudo && !t.extra)
      .map((t) => t.titleParams.date),
  ).toEqual(['2026-12-14', '2026-12-14']);
});

it('自分の時間にもう置けない案は、置ける大人を担当にして見せ、その人の時刻で選ぶ', async () => {
  const sessions = demoSessions();
  const id = sessions.create('arrived');
  const option = (await sessions.view(id, 'b'))?.plan.arrangements
    .find((a) => a.key === care)
    ?.options.find((o) => o.key === gakudo);
  // 決め時は、大人の誰か（a）が間に合う最後。b が自分でするなら、もっと早い。
  expect(option?.decisionDeadline).toBe('2026-11-30T17:20+09:00');
  const early = (await sessions.preview(id, 'b', care))?.find((p) => p.optionKey === gakudo);
  expect(early?.assigneeId).toBe('b');
  expect(early?.steps[0]?.start).toBe('2026-11-26T17:05+09:00');
  expect(early?.later).toEqual({ memberId: 'a', start: '2026-11-30T17:20+09:00' });
  // b の分の時刻を過ぎた後：b には置けないので、a に提案する形で見せる（時刻の無い作業を b に置かない）。
  const advanced = await sessions.command(id, 'b', 'clock', {
    type: 'advanceClock',
    to: '2026-11-27T12:00+09:00',
  });
  expect(advanced?.result.status).toBe('ok');
  const late = (await sessions.preview(id, 'b', care))?.find((p) => p.optionKey === gakudo);
  expect(late?.assigneeId).toBe('a');
  expect(late?.later).toBeUndefined();
  expect(late?.steps.every((s) => s.assigneeId === 'a' && s.start !== undefined)).toBe(true);
  const chose = await sessions.command(id, 'b', 'choose', {
    type: 'chooseOption',
    arrangementKey: care,
    optionKey: gakudo,
    role: 'primary',
    assigneeId: late?.assigneeId ?? 'b',
    ...(late?.seen ? { seen: late.seen } : {}),
  });
  expect(chose?.result.status).toBe('ok');
  const write = chose?.view.plan.tasks.find((t) => t.key === keys.task(gakudo, 'write'));
  expect(write?.assigneeId).toBe('a');
  expect(write?.start).toBe(late?.steps[0]?.start);
});
