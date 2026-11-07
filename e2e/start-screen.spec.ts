import { expect, test } from '@playwright/test';

for (const language of ['ja', 'en'] as const) {
  test(`${language}：用意した場面の入口は携帯の最初の画面にあり、場面を開ける`, async ({ page }) => {
    await page.goto('/');
    if (language === 'en') await page.getByRole('button', { name: 'English', exact: true }).click();
    await expect(page.getByRole('heading', {
      name: language === 'ja' ? '段取りを、ひとりの頭に残さない。' : 'Don’t leave the planning in one person’s head.',
    })).toBeVisible();
    const button = page.getByRole('button', {
      name: language === 'ja' ? '用意した場面で見る（審査の方へ）' : 'View prepared scenes (for judges)',
      exact: true,
    });
    await expect(button).toBeEnabled();
    // 試験の click が自動でスクロールする前に、390×844 の表示内に全体があるかを見る。
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? Infinity) + (box?.width ?? Infinity)).toBeLessThanOrEqual(390);
    expect(box?.y).toBeGreaterThanOrEqual(0);
    expect((box?.y ?? Infinity) + (box?.height ?? Infinity)).toBeLessThanOrEqual(844);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await button.click();
    await expect(
      page.getByRole('combobox', { name: language === 'ja' ? '場面' : 'Scene' }),
    ).toBeVisible();
  });
}
