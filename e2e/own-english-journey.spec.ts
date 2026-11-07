// 英語の広い画面でも、空の試用と「分からない」の入口が一続きになる。
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, locale: 'en-US' });

test('英語で始め、見本を開いて見守りの未確認に答える', async ({ page, request }) => {
  const output = fileURLToPath(new URL('../.local/e2e-results/own/', import.meta.url));
  await mkdir(output, { recursive: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.getByText('Turn school notices into a family plan')).toBeVisible();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByText('Use made-up nicknames', { exact: false })).toBeVisible();
  await page.getByLabel('What should we call you?').fill('Adult A');
  await page.getByLabel('Your child’s nickname').fill('Child H');
  await page.getByRole('button', { name: 'Start with this family' }).click();
  await expect(page.getByText('No notices yet')).toBeVisible();
  await page.screenshot({ path: `${output}english-empty.png` });
  await expect(page.getByText('nothing is sent to Claude now', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: /^Try an example/ }).click();
  await expect(page.getByRole('button', { name: 'Enter who can watch' })).toBeVisible();
  await page.getByRole('button', { name: 'Enter who can watch' }).click();
  await page.getByRole('radio', { name: 'Works from home' }).check();
  await expect(page.getByText('working at home, can’t watch the child', { exact: false })).toBeVisible();
  await expect(page.getByText('Before and after this, at home and can watch the child', { exact: false })).toBeVisible();
  await page.screenshot({ path: `${output}english-facts.png` });
  await page.getByRole('radio', { name: 'As usual' }).check();
  await page.getByRole('button', { name: 'See what this changes' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add a way to cover the day' })).toBeVisible();
  await page.getByRole('button', { name: 'Add a way to cover the day' }).click();
  await expect(page.getByLabel('Their nickname')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
  expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
});
