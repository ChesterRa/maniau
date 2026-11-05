// 一度 OK があっても、頼んだ日が変われば「決まった」扱いにしない。
import { expect, test } from '@playwright/test';

test('前の日への OK は、日が変わると確かめ待ちになる', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '用意した場面で見る（審査の方へ）' }).click();
  const made = page.waitForResponse((response) =>
    response.request().method() === 'POST' &&
    response.url().endsWith('/api/demo/sessions') &&
    response.request().postDataJSON()?.stage === 'chase',
  );
  await page.getByRole('combobox', { name: '場面' }).selectOption('chase');
  const { sessionId } = (await (await made).json()) as { sessionId: string };
  const api = `http://127.0.0.1:18797/api/demo/sessions/${sessionId}`;
  const send = async (memberId: string, operationId: string, command: unknown) => {
    const response = await request.post(`${api}/commands`, { data: { memberId, operationId, command } });
    expect(response.status()).toBe(200);
    expect((await response.json()).result.status).toBe('ok');
  };
  await send('b', 'status-reply', { type: 'recordReply', requestId: 'r-grandma', reply: 'yes' });
  await send('a', 'status-date', {
    type: 'correctItem', itemId: 'n1:i6', interpretation: { date: '2026-12-14', writtenWeekday: 1 },
  });
  const view = await (await request.get(`${api}/view?member=b`)).json();
  expect(view.plan.requests.find((entry: { requestId: string }) => entry.requestId === 'r-grandma'))
    .toMatchObject({ state: 'confirmed', live: true, needsCheck: true });
  expect(view.today.main.map((card: { kind: string }) => card.kind)).toContain('check');

  await page.getByRole('button', { name: '健太', exact: true }).click();
  await page.getByRole('button', { name: '彩', exact: true }).click();
  await expect(page.getByText('おばあちゃんへのお願いは、まだ要りますか？')).toBeVisible();
  await expect(page.getByText('おばあちゃんから OK の返事', { exact: true })).toHaveCount(0);
  expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
});
