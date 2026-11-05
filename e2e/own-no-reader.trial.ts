// 読み取りを提供しないサーバーで、架空の家族の空の入口を確認する。
import { expect, test } from '@playwright/test';

test('読み取りが無い時、できないことと代わりの入口が分かる', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'はじめる', exact: true }).click();
  await page.getByLabel('あなたの呼び名').fill('大人A');
  await page.getByLabel('子どもの呼び名').fill('子H');
  const made = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/demo/sessions'));
  await page.getByRole('button', { name: 'この家族で始める' }).click();
  const response = await made;
  expect(response.status()).toBe(200);
  const { sessionId } = await response.json() as { sessionId: string };
  await expect(page.getByText('まだお知らせがありません')).toBeVisible();
  await expect(page.getByText('このサーバーでは、いま書いた文を読めません', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: /^例で試す/ })).toBeVisible();
  await page.getByRole('button', { name: /すること.*手で|手で.*すること/ }).click();
  await expect(page.getByRole('heading', { name: 'することを足す' })).toBeVisible();
  await page.getByLabel('言ったこと（そのまま）').fill('12月9日までに架空の書類を出す');
  await page.getByLabel('何を（短く）').fill('架空の書類を出す');
  await page.getByRole('radio', { name: 'いつまでに済ませる' }).check();
  await page.getByLabel('日', { exact: true }).fill('2026-12-09');
  const read = async () => (await (await request.get(`http://127.0.0.1:18797/api/demo/sessions/${sessionId}/view?member=a1`)).json());
  await page.getByRole('button', { name: 'この変更で変わることを見る' }).click();
  expect((await read()).items).toEqual([]);
  await page.getByRole('button', { name: 'この内容で保存' }).click();
  await expect.poll(async () => (await read()).items.length).toBe(1);
  const view = await read();
  expect(view.items[0].item).toMatchObject({ kind: 'need', evidence: 'stated', written: '12月9日までに架空の書類を出す' });
  expect(view.sources[0].sender).toBe('family');
  expect(await (await request.get('http://127.0.0.1:18797/__e2e/reads')).json()).toEqual([]);
  expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
});
