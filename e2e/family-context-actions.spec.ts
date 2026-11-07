import { expect, test } from '@playwright/test';

for (const lang of ['ja', 'en'] as const) {
  test(`${lang}：うちの情報を項目に合う操作から直せる`, async ({ page }) => {
    await page.goto('/');
    if (lang === 'en') await page.getByRole('button', { name: 'English', exact: true }).click();
    await page.getByRole('button', {
      name: lang === 'ja' ? '用意した場面で見る（審査の方へ）' : 'View prepared scenes (for judges)',
      exact: true,
    }).click();
    await page.getByRole('button', { name: lang === 'ja' ? 'うち' : 'Family', exact: true }).click();

    const resource = page
      .locator('section')
      .filter({ has: page.getByText(lang === 'ja' ? '周りの資源' : 'Around us', { exact: true }) })
      .first();
    await expect(resource).toContainText(lang === 'ja' ? '済んでいるか分かりません' : 'Not known whether it’s done');
    await expect(resource).toContainText(lang === 'ja' ? '出典：デモのための架空の決まり' : 'Source: a made-up rule for the demo');
    await expect(resource).toContainText(lang === 'ja' ? '何日前までに済ませるかは確かめていません' : 'How many days ahead hasn’t been confirmed');
    await resource.getByRole('button', { name: lang === 'ja' ? '周りの資源を直す' : 'Edit resources', exact: true }).click();
    await expect(resource.getByRole('button', { name: lang === 'ja' ? '候補' : 'Candidate', exact: true }).first()).toBeVisible();
    await resource.getByRole('button', { name: lang === 'ja' ? 'やめる' : 'Cancel', exact: true }).click();

    const names = lang === 'ja'
      ? ['習い事の送り迎えを直す', 'ふだんの一週間を直す', '店の営業時間を直す', '取れる手を直す']
      : ['Edit lesson drop-off and pick-up', 'Edit the usual week', 'Edit shop hours', 'Edit ways to cover'];
    for (const name of names) {
      await page.getByRole('button', { name, exact: true }).click();
      await expect(page.getByRole('button', { name: lang === 'ja' ? '変わることを見る' : 'See what changes', exact: true })).toBeVisible();
      await page.getByRole('button', { name: lang === 'ja' ? 'やめる' : 'Cancel', exact: true }).click();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
}
