import { expect, test } from '@playwright/test';

for (const lang of ['ja', 'en'] as const) {
  test(`${lang}：見守り方のおすすめと、手を足す入口を見分けられる`, async ({ page, request }) => {
    await page.goto('/');
    if (lang === 'en') await page.getByRole('button', { name: 'English', exact: true }).click();
    await page
      .getByRole('button', {
        name: lang === 'ja' ? '用意した場面で見る（審査の方へ）' : 'View prepared scenes (for judges)',
        exact: true,
      })
      .click();
    await page
      .getByRole('button', {
        name: lang === 'ja' ? '子どもの見守り方を選ぶ' : 'Choose how to arrange care',
        exact: true,
      })
      .click();

    const actions = page.getByRole('button', {
      name: lang === 'ja' ? /これに決める$/ : /Go with this$/,
    });
    await expect(actions).toHaveCount(4);
    await expect(actions.nth(0)).toBeEnabled();
    await expect(actions.nth(0)).toHaveClass(/\bbg-accent\b/);
    for (const index of [1, 2, 3]) await expect(actions.nth(index)).toHaveClass(/\bbg-white\b/);

    if (lang === 'ja') {
      const option = (name: string) =>
        page
          .getByText(name, { exact: true })
          .locator('xpath=ancestor::div[contains(@class,"rounded-[18px]")][1]');
      const school = await option('学童に預ける').innerText();
      expect(school).toContain('17:05');
      expect(school.match(/17:20/g)).toHaveLength(1);
      const leave = await option('健太さんが休む').innerText();
      expect(leave.match(/17:25/g)).toHaveLength(1);
      expect(leave).toContain('目安');
      expect(leave).toContain('会社に休みを伝える');
    }

    const summary = page
      .locator('summary')
      .filter({ hasText: lang === 'ja' ? '取れる手を足す' : 'Add a way to cover the day' });
    const panel = summary.locator('..');
    const helper = page.getByLabel(lang === 'ja' ? '頼める人の呼び名' : 'Their nickname');
    await expect(panel).not.toHaveAttribute('open', '');
    await expect(helper).toBeHidden();
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(panel).toHaveAttribute('open', '');
    await helper.fill('Sample');
    await summary.focus();
    await page.keyboard.press('Space');
    await expect(helper).toBeHidden();
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(helper).toHaveValue('Sample');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
  });
}
