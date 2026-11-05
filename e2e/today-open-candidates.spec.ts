// 予定の候補を決める入口だけが残る時、「いま決めることはない」と言わない。
import { expect, test } from '@playwright/test';

test('取り消しを伝え終えた後も、まだ日を決めていない用件を今やることに出す', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '用意した場面で見る（審査の方へ）' }).click();
  const made = page.waitForResponse((response) =>
    response.request().method() === 'POST' &&
    response.url().endsWith('/api/demo/sessions') &&
    response.request().postDataJSON()?.stage === 'club',
  );
  await page.getByRole('combobox', { name: '場面' }).selectOption('club');
  const { sessionId } = (await (await made).json()) as { sessionId: string };
  const api = `http://127.0.0.1:18797/api/demo/sessions/${sessionId}`;
  const view = async (member: string) => (await request.get(`${api}/view?member=${member}`)).json();
  for (const member of ['a', 'b']) {
    const before = await view(member);
    const cancel = before.today.main.find((card: { kind: string }) => card.kind === 'cancel');
    expect(cancel).toBeDefined();
    const response = await request.post(`${api}/commands`, { data: {
      memberId: member, operationId: `when-after-cancel-${member}`,
      command: { type: 'recordCancellationSent', requestId: cancel.request.requestId },
    } });
    expect(response.status()).toBe(200);
    expect((await response.json()).result.status).toBe('ok');
  }
  const after = await view('a');
  expect(after.today.main).toEqual([]);
  expect(after.today.quiet).toEqual([]);
  expect(after.plan.requirements.some((r: { kind: string; live: boolean; when?: { chosen?: unknown } }) =>
    r.kind === 'need' && r.live && r.when && !r.when.chosen,
  )).toBe(true);

  await page.getByRole('button', { name: '彩', exact: true }).click();
  await page.getByRole('button', { name: '健太', exact: true }).click();
  await expect(page.getByRole('button', { name: /クラブの練習：答えを集めています/ })).toBeVisible();
  expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
  await expect(page.getByText('いま決めることはありません', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '今やること', exact: true })).toBeVisible();
});
