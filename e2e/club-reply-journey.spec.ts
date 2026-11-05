import { expect, test } from '@playwright/test';

test('架空の集まりで、相手の返事を読み、日を選び、その日のやり方に進む', async ({ page, browser, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '用意した場面で見る（審査の方へ）' }).click();
  await page.getByRole('combobox', { name: '場面' }).selectOption('club');
  await page.getByRole('button', { name: 'クラブの練習：答えを集めています（候補 2 つ）' }).click();
  await expect(page.getByText('表は横に送れます（右に、ほかの人の答えがあります）。')).toBeVisible();
  const scroll = page.locator('table').locator('..');
  const tableBox = await scroll.boundingBox();
  const countBox = await page.locator('table tbody tr').first().locator('td').first().boundingBox();
  if (!tableBox || !countBox) throw new Error('人数または表が見つかりません');
  expect(countBox.x).toBeGreaterThanOrEqual(tableBox.x);
  expect(countBox.x + countBox.width).toBeLessThanOrEqual(tableBox.x + tableBox.width + 1);
  await expect(page.getByText(/要る人のうち、コーチ は「はい」かどうか/)).toBeVisible();
  await expect(page.getByText(/この人の答えで、条件を満たすかが変わることがあります：エンドウさん.*オカダさん.*キムラさん/)).toBeVisible();
  const coach = page.getByText('コーチ：リンクを出しています', { exact: true }).locator('..');
  await coach.getByRole('button', { name: '出し直す' }).click();
  const url = await coach.locator('input[readonly]').inputValue();
  expect(url.includes('/answer#')).toBe(true);
  const guest = await browser.newContext({ locale: 'ja-JP', viewport: { width: 390, height: 844 } });
  try {
    const answer = await guest.newPage();
    await answer.goto(url);
    await expect(answer.getByText('コーチへ')).toBeVisible();
    await expect(answer.getByText('今の答え：たぶん（午後に別の試合がある）')).toBeVisible();
    await answer.getByRole('button', { name: '○ はい', exact: true }).nth(1).click();
    await expect(answer.getByText('答えを送りました。')).toBeVisible();
    await page.getByRole('button', { name: '最新の答えを読む' }).click();
    const card = page.locator('section').filter({ has: page.getByRole('heading', { name: /12\/19.*9:00/ }) });
    await expect(card.getByText('答えの条件を満たしています')).toBeVisible();
    await card.getByRole('button', { name: 'この日に決めたら変わることを見る' }).click();
    await card.getByRole('button', { name: 'この日に決める', exact: true }).click();
    await expect(page.getByText('決めた日', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'この日の手配を見る' }).click();
    await expect(page.getByText('地区センターの体育室を予約する', { exact: false }).first()).toBeVisible();
    expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
  } finally {
    await guest.close();
  }
});
