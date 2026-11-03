// 頼んだ・出したの記録：子の居場所の手配は、画面で見せた頼む時間（手配の区間。頼む文と同じ）を付けて送る。
// 見せた後に日が直されていたら、サーバーが断る（古い画面の「送った」で、新しい日を送ったことにしない）。
import { expect, it } from 'vitest';
import { askDraft, sentCommand } from '../src/screens';
import { ctxFor } from './ctx';

it('頼む文と同じ頼む時間を、送ったの記録に付ける', () => {
  const ctx = ctxFor('asked', 'b', 'ja');
  const task = ctx.plan.tasks.find(
    (t) => t.key === 'task:opt:arr:childCare:n1:i6:c:opt-grandma:ask',
  );
  if (!task) throw new Error('祖母に頼む作業が無い');
  const arrangement = ctx.plan.arrangements.find((a) => a.key === task.basis.arrangementKey);
  if (!arrangement) throw new Error('子の居場所の手配が無い');
  expect(sentCommand(ctx, task)).toMatchObject({
    type: 'recordSent',
    taskKey: task.key,
    window: { start: arrangement.start, end: arrangement.end },
  });
  expect(arrangement.start.startsWith('2026-12-07')).toBe(true);
  expect(askDraft(ctx, task)).toContain('12月7日');
});

it('通用の「すること」の窓の手配も、頼む時間を送ったの記録に付ける（締切の形には付けない）', () => {
  const window = { start: '2026-11-26T08:00+09:00', end: '2026-11-26T18:00+09:00' };
  const ctx = {
    plan: {
      arrangements: [
        { key: 'arr:need:f-1:i1', kind: 'need', needShape: 'window', ...window },
        { key: 'arr:need:f-2:i1', kind: 'need', needShape: 'by', ...window },
      ],
    },
  } as unknown as Parameters<typeof sentCommand>[0];
  const task = (arrangementKey: string) =>
    ({
      key: `task:${arrangementKey}`,
      basis: { itemIds: [], arrangementKey },
    }) as unknown as Parameters<typeof sentCommand>[1];
  expect(sentCommand(ctx, task('arr:need:f-1:i1'))).toMatchObject({ window });
  expect(sentCommand(ctx, task('arr:need:f-2:i1'))).not.toHaveProperty('window');
});
