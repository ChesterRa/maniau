import { expect, test } from '@playwright/test';

for (const language of ['ja', 'en'] as const) {
  test(`${language}：家のやり方の期限を日数に合う言葉で見せる`, async ({ page }) => {
    await page.goto('/');
    if (language === 'en') await page.getByRole('button', { name: 'English', exact: true }).click();
    await page
      .getByRole('button', {
        name:
          language === 'ja'
            ? '用意した場面で見る（審査の方へ）'
            : 'View prepared scenes (for judges)',
        exact: true,
      })
      .click();
    await page.getByRole('button', { name: language === 'ja' ? 'うち' : 'Family', exact: true }).click();
    const ways = page.locator('section').filter({
      hasText: language === 'ja' ? '「すること」のやり方' : 'Ways to get things done',
    });
    await expect(ways).toContainText(
      language === 'ja' ? '決め時：1日前の 21:00 まで' : 'Decision time: By 21:00, 1 day before',
    );
    if (language === 'en') {
      await expect(ways).not.toContainText('1 days before');
      await expect(ways).not.toContainText('Decide by: By');
    }
  });
}
