import { expect, test } from '@playwright/test';

for (const lang of ['ja', 'en'] as const) {
  test(`${lang}：決め時を条件と手に添えて表示する`, async ({ page }) => {
    await page.goto('/');
    if (lang === 'en') await page.getByRole('button', { name: 'English', exact: true }).click();
    await page.getByRole('button', {
      name: lang === 'ja' ? '用意した場面で見る（審査の方へ）' : 'View prepared scenes (for judges)',
      exact: true,
    }).click();

    const card = page.getByRole('heading', { name: /12\/7/ }).first().locator('..');
    await expect(card).toContainText(lang === 'ja' ? '12/5（土）なら' : '12/5');
    const option = card.getByText(lang === 'ja' ? /「学童に預ける」なら/ : /if you choose “After-school care”/);
    const time = card.getByText(lang === 'ja' ? /17:20ごろまで（目安）/ : /By about.*5:20 PM \(estimate\)/);
    await expect(option).toBeVisible();
    await expect(time).toBeVisible();
    const optionBox = await option.boundingBox();
    const timeBox = await time.boundingBox();
    expect(optionBox).not.toBeNull();
    expect(timeBox).not.toBeNull();
    expect(timeBox?.y ?? 0).toBeGreaterThan(optionBox?.y ?? Infinity);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    await card.getByRole('button', {
      name: lang === 'ja' ? '子どもの見守り方を選ぶ' : 'Choose how to arrange care',
      exact: true,
    }).click();
    await expect(page.getByText(lang === 'ja' ? 'おすすめ' : 'Suggested', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: lang === 'ja' ? 'よてい' : 'Schedule', exact: true }).click();
    await expect(page.getByText(lang === 'ja' ? '表示する事はありません' : 'No entries to show').first()).toBeVisible();
  });
}
