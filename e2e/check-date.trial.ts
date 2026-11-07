// 390px の画面から、書かれた日の無い架空のお知らせを確認する。外部 API は呼ばない。
import { expect, test } from '@playwright/test';

test('きょうから日付の確認を開き、原文と見比べて記録する', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'はじめる', exact: true }).click();
  await page.getByLabel('あなたの呼び名').fill('大人A');
  await page.getByLabel('子どもの呼び名').fill('子H');
  await page.getByRole('button', { name: 'この家族で始める' }).click();
  await page.getByRole('button', { name: 'お知らせを入れる', exact: true }).click();
  await page.getByRole('textbox', { name: 'お知らせを入れる' }).fill('あした、運動靴を持ってきてください。');
  const read = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/notices'));
  await page.getByRole('button', { name: '読み取る', exact: true }).click();
  const response = await read;
  expect(response.status()).toBe(200);
  const result = await response.json();
  const sessionId = /\/api\/demo\/sessions\/([^/]+)\/notices$/.exec(response.url())?.[1];
  expect(sessionId).toBeTruthy();
  await page.getByRole('button', { name: 'きょう', exact: true }).last().click();
  await page.getByRole('button', { name: '「運動靴」の日付を確かめる' }).click();
  const details = page.locator('details').filter({ has: page.getByText('読み取った日付を直す', { exact: true }) });
  await expect(details).toHaveAttribute('open', '');
  await expect(details.getByText('読み取った名前：運動靴')).toBeVisible();
  await expect(details.getByLabel('正しい日付')).toHaveValue('2026-11-26');
  await details.getByRole('button', { name: '変わることを見る' }).click();
  await details.getByRole('button', { name: 'この日付で記録する' }).click();
  const view = await (await request.get(`http://127.0.0.1:18797/api/demo/sessions/${sessionId}/view?member=a1`)).json();
  expect(view.items.find((entry: { item: { sourceId: string } }) => entry.item.sourceId === result.sourceId).trusted).toBe(true);
  expect(view.plan.requirements.some((requirement: { what: string }) => requirement.what === '運動靴')).toBe(true);
  expect(errors).toEqual([]);
  expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
});
