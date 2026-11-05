// 写真を選ぶと送信が始まるため、選ぶ前に試用の範囲と送り先を見せる。
// ファイルは選ばず、架空の家族とローカルの試験サーバーだけを使う。
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const output = fileURLToPath(new URL('../.local/e2e-results/photo/', import.meta.url));

test('日本語の試用では、写真を選ぶ前に架空限定と送り先が見える', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'はじめる', exact: true }).click();
  await page.getByLabel('あなたの呼び名').fill('大人A');
  await page.getByLabel('子どもの呼び名').fill('子H');
  await page.getByRole('button', { name: 'この家族で始める' }).click();
  await page.getByRole('button', { name: 'お知らせを入れる', exact: true }).click();

  const photo = page.locator('input[type=file]');
  await expect(photo).toHaveCount(1);
  expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
  const note = photo.locator('xpath=../..').getByText(/架空/);
  await expect(note).toBeVisible();
  await expect(note).toBeInViewport();
  await expect(note).toContainText(/選/);
  await expect(note).toContainText('Claude');
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: `${output}notice-ja.png` });
});

test('英語の試用でも、写真を選ぶ前に架空限定と送り先が見える', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.getByLabel('What should we call you?').fill('Adult A');
  await page.getByLabel('Your child’s nickname').fill('Child H');
  await page.getByRole('button', { name: 'Start with this family' }).click();
  await page.getByRole('button', { name: 'Add a notice', exact: true }).click();

  const photo = page.locator('input[type=file]');
  await expect(photo).toHaveCount(1);
  expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
  const note = photo.locator('xpath=../..').getByText(/made.up|fictional/i);
  await expect(note).toBeVisible();
  await expect(note).toBeInViewport();
  await expect(note).toContainText(/select|choos/i);
  await expect(note).toContainText('Claude');
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: `${output}notice-en.png` });
});
