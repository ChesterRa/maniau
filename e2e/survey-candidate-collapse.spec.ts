import { expect, test } from '@playwright/test';

for (const lang of ['ja', 'en'] as const) {
  test(`${lang}：入れた候補の登録欄を開き、確かめて保存できる`, async ({ page, request }) => {
    await page.goto('/');
    if (lang === 'en') await page.getByRole('button', { name: 'English', exact: true }).click();
    await page
      .getByRole('button', {
        name: lang === 'ja' ? '用意した場面で見る（審査の方へ）' : 'View prepared scenes (for judges)',
        exact: true,
      })
      .click();
    await page.getByRole('button', { name: lang === 'ja' ? 'うち' : 'Family', exact: true }).click();
    await page
      .getByRole('button', { name: lang === 'ja' ? '周りを調べる' : 'Look around us', exact: true })
      .click();

    const decide = page
      .getByRole('button', {
        name: lang === 'ja' ? 'この家での扱いを決める' : 'Decide how your family treats it',
        exact: true,
      })
      .first();
    const name = (
      await decide
        .locator('xpath=ancestor::div[contains(@class,"bg-paper")][1]')
        .getByRole('heading')
        .first()
        .textContent()
    )?.trim();
    expect(name).toBeTruthy();
    await decide.click();
    await page
      .getByRole('button', {
        name: lang === 'ja' ? 'この家の候補にする' : 'Add as a candidate for us',
        exact: true,
      })
      .click();
    await page
      .getByRole('button', {
        name: lang === 'ja' ? 'この内容で保存' : 'Save these changes',
        exact: true,
      })
      .click();

    const candidate = page
      .locator('div.rounded-xl.bg-paper')
      .filter({ has: page.getByRole('heading', { name, exact: true }) });
    const toggle = candidate.getByRole('button', {
      name: lang === 'ja' ? '登録ややり方を確かめる' : 'Check registration and ways to use it',
      exact: true,
    });
    const needed = candidate.getByRole('button', {
      name: lang === 'ja' ? '要る（確かめた）' : 'Needed (I checked)',
      exact: true,
    });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(candidate).toContainText(
      lang === 'ja' ? 'Claude の読み：' : 'Claude’s reading:',
    );
    await expect(candidate.getByRole('link').first()).toBeVisible();
    await expect(needed).toHaveCount(0);

    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await needed.click();
    await expect(needed).toHaveAttribute('aria-pressed', 'true');
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(needed).toHaveAttribute('aria-pressed', 'true');
    await candidate
      .getByRole('button', {
        name: lang === 'ja' ? '登録と前提を確かめる' : 'Confirm registration and prerequisites',
        exact: true,
      })
      .click();
    await page
      .getByRole('button', {
        name: lang === 'ja' ? 'この内容で保存' : 'Save these changes',
        exact: true,
      })
      .click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
  });
}
