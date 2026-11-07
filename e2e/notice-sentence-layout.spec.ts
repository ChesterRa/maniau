import { expect, test } from '@playwright/test';

for (const lang of ['ja', 'en'] as const) {
  test(`${lang}：お知らせの原文の下に読み取りの印を出す`, async ({ page }) => {
    await page.goto('/');
    if (lang === 'en') await page.getByRole('button', { name: 'English', exact: true }).click();
    await page.getByRole('button', {
      name: lang === 'ja' ? '用意した場面で見る（審査の方へ）' : 'View prepared scenes (for judges)',
      exact: true,
    }).click();
    await page.getByRole('button', { name: lang === 'ja' ? 'お知らせ' : 'Notices', exact: true }).click();
    const notice = page.locator('section').filter({
      has: page.getByRole('heading', { name: '学習発表会のお知らせ', exact: true }),
    });
    const original = notice.getByText('12月5日(土)に学習発表会を行います。', { exact: true }).first();
    const status = original.locator('..').getByText(lang === 'ja' ? /よていに出します/ : /Shown in Schedule/);
    await expect(original).toBeVisible();
    await expect(status).toContainText('12/5');
    const originalBox = await original.boundingBox();
    const statusBox = await status.boundingBox();
    expect(originalBox).not.toBeNull();
    expect(statusBox).not.toBeNull();
    expect(statusBox?.y ?? 0).toBeGreaterThanOrEqual((originalBox?.y ?? Infinity) + (originalBox?.height ?? Infinity));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
}
