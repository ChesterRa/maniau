import { expect, test, type Locator } from '@playwright/test';

const labels = {
  ja: {
    start: '用意した場面で見る（審査の方へ）', scene: '場面', adult: '使う人', guide: '場面のはじめ',
    plusHour: '+1時間', restart: 'やり直す', leave: '初めの画面へ', begin: 'はじめる',
    stageNames: [
      '11/25 お知らせが届いた', '11/26 帰りの買い物', '11/29 返事がまだ', '11/30 学童にも申し込んだ',
      '12/4 延期のお知らせ', '12/5 見てもらう日を決める', '12/6 練習日を決める', '12/6 手が離せない時間',
    ],
  },
  en: {
    start: 'View prepared scenes (for judges)', scene: 'Scene', adult: 'Viewing as', guide: 'At the start',
    plusHour: '+1 hour', restart: 'Restart', leave: 'Back to start', begin: 'Start',
    stageNames: [
      '11/25 Notice arrives', '11/26 Errand on the way home', '11/29 No reply yet', '11/30 Backup booked',
      '12/4 Postponed', '12/5 Choose a day for a sitter', '12/6 Choose a practice day', '12/6 Busy time',
    ],
  },
} as const;

async function expectInFirstScreen(element: Locator) {
  await expect(element).toBeVisible();
  const box = await element.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? Infinity) + (box?.width ?? Infinity)).toBeLessThanOrEqual(390);
  expect(box?.y).toBeGreaterThanOrEqual(0);
  expect((box?.y ?? Infinity) + (box?.height ?? Infinity)).toBeLessThanOrEqual(758);
}

for (const language of ['ja', 'en'] as const) {
  test(`${language}：場面と使う人の操作を携帯の初めの画面に表示する`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    if (language === 'en') await page.getByRole('button', { name: 'English', exact: true }).click();
    const text = labels[language];
    await page.getByRole('button', { name: text.start, exact: true }).click();
    const scene = page.getByRole('combobox', { name: text.scene });
    const adult = page.getByRole('group', { name: text.adult });
    const guide = page.getByText(text.guide, { exact: true });
    await expectInFirstScreen(scene);
    await expectInFirstScreen(adult);
    await expectInFirstScreen(guide);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect(await scene.locator('option').allTextContents()).toEqual([...text.stageNames]);
    await expect(page.getByRole('button', { name: text.plusHour })).toBeEnabled();
    await expect(page.getByRole('button', { name: text.restart })).toBeEnabled();
    await expect(page.getByRole('button', { name: text.leave })).toBeEnabled();

    await scene.selectOption('chase');
    await expect(guide).toBeVisible();
    await adult.getByRole('button', { name: '健太', exact: true }).click();
    await expect(adult.getByRole('button', { name: '健太', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await adult.getByRole('button', { name: '彩', exact: true }).click();
    await expect(adult.getByRole('button', { name: '彩', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const clock = page.getByText(language === 'ja' ? /^デモの時計/ : /^Demo clock/);
    await expect(clock).toContainText('11/29');
    const before = await clock.innerText();
    await page.getByRole('button', { name: text.plusHour }).click();
    await expect.poll(() => clock.innerText()).not.toBe(before);
    await page.getByRole('button', { name: text.restart }).click();
    await expect.poll(() => clock.innerText()).toBe(before);
    await page.getByRole('button', { name: text.leave }).click();
    await expect(page.getByRole('button', { name: text.begin, exact: true })).toBeVisible();
  });
}
