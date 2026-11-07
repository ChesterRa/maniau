// 引き受けたが未済の作業を、済んだことではなく「今やること」に出す。
import { expect, test, type Locator } from '@playwright/test';
import { proposalSnapshot } from '../packages/core/src/index';

async function expectInNow(item: Locator) {
  const section = await item.evaluate((element) => {
    const names = ['今やること', '頼んだこと', '決まったこと'];
    const headings = [...document.querySelectorAll('h2')].filter((heading) =>
      names.includes(heading.textContent?.trim() ?? ''),
    );
    return headings.filter((heading) =>
      Boolean(heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).at(-1)?.textContent?.trim();
  });
  expect(section).toBe('今やること');
}

test('引き受けた買い物は、日時とともに自分のやることに残る', async ({ page, request }) => {
  await page.goto('/');
  const made = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/api/demo/sessions'),
  );
  await page.getByRole('button', { name: '用意した場面で見る（審査の方へ）' }).click();
  const { sessionId } = (await (await made).json()) as { sessionId: string };
  const api = `http://127.0.0.1:18797/api/demo/sessions/${sessionId}`;
  const view = async (member: string) => (await request.get(`${api}/view?member=${member}`)).json();
  const send = async (memberId: string, operationId: string, command: unknown) => {
    const response = await request.post(`${api}/commands`, { data: { memberId, operationId, command } });
    const body = await response.json();
    expect(response.status(), JSON.stringify(body.result)).toBe(200);
    expect(body.result.status).toBe('ok');
  };

  const before = await view('b');
  await send('b', 'visibility-no-shirt', {
    type: 'answer',
    unknownId: 'u-atHome:n1:i5',
    value: 'no',
    seen: { what: '白い長袖シャツ', throughSeq: before.plan.throughSeq },
  });
  const proposed = await view('a');
  const buy = proposed.plan.tasks.find(
    (task: { basis: { arrangementKey?: string }; assigneeId?: string }) =>
      task.basis.arrangementKey === 'arr:purchase:n1:i5' && task.assigneeId === 'a',
  );
  const shown = buy && proposalSnapshot(buy);
  expect(shown).toBeDefined();
  await send('a', 'visibility-accept-shirt', { type: 'accept', taskKey: buy.key, shown });
  const accepted = await view('a');
  expect(accepted.today.quiet).toContainEqual(
    expect.objectContaining({ kind: 'todo', task: expect.objectContaining({ key: buy.key, commitment: 'accepted' }) }),
  );

  await page.getByRole('button', { name: '健太', exact: true }).click();
  const todo = page.locator('section').filter({ hasText: '白い長袖シャツを買う' }).first();
  await expect(todo).toBeVisible();
  expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
  await expectInNow(todo);
  await expect(todo).toContainText('11/26');
  await expect(todo).not.toContainText('決まったこと');
});

test('締切後に持ち物が無いと分かった時も、家族に今の状態を見せる', async ({ page, request }) => {
  await page.goto('/');
  const made = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/api/demo/sessions'),
  );
  await page.getByRole('button', { name: '用意した場面で見る（審査の方へ）' }).click();
  const { sessionId } = (await (await made).json()) as { sessionId: string };
  const api = `http://127.0.0.1:18797/api/demo/sessions/${sessionId}`;
  const view = async (member: string) => (await request.get(`${api}/view?member=${member}`)).json();
  const send = async (memberId: string, operationId: string, command: unknown) => {
    const response = await request.post(`${api}/commands`, { data: { memberId, operationId, command } });
    const body = await response.json();
    expect(response.status(), JSON.stringify(body.result)).toBe(200);
    expect(body.result.status).toBe('ok');
  };

  const change = {
    type: 'correctItem', itemId: 'n1:i5', interpretation: { date: '2026-12-05' },
  };
  const previewResponse = await request.post(`${api}/change-preview`, { data: { memberId: 'b', command: change } });
  expect(previewResponse.status()).toBe(200);
  const { preview } = await previewResponse.json();
  await send('b', 'bring-correct-date', { ...change, seen: { throughSeq: preview.throughSeq, changes: preview.seen } });
  const corrected = await view('b');
  await send('b', 'bring-yes', {
    type: 'answer', unknownId: 'u-atHome:n1:i5', value: 'yes',
    seen: { what: '白い長袖シャツ', throughSeq: corrected.plan.throughSeq },
  });
  await send('b', 'bring-clock', { type: 'advanceClock', to: '2026-12-05T09:00+09:00' });
  const beforeNo = await view('a');
  await send('a', 'bring-no', {
    type: 'answer', unknownId: 'u-atHome:n1:i5', value: 'no',
    seen: { what: '白い長袖シャツ', throughSeq: beforeNo.plan.throughSeq },
  });
  const missing = await view('a');
  expect(missing.today.quiet).toContainEqual(expect.objectContaining({
    kind: 'bring', bought: false, requirement: expect.objectContaining({ atHome: 'no' }),
  }));

  await page.getByRole('button', { name: '健太', exact: true }).click();
  const bring = page.locator('section').filter({ hasText: '白い長袖シャツを持って行く' }).first();
  await expect(bring).toBeVisible();
  expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
  await expectInNow(bring);
  await expect(bring).toContainText('家に無い');
  await expect(bring).not.toContainText('決まったこと');
});
