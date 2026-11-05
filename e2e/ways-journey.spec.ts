import { expect, test } from '@playwright/test';

test('選べるやり方が無い時、頼める人と方法を足して本命に選ぶ', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByRole('button', { name: '用意した場面で見る（審査の方へ）' }).click();
  await page.getByRole('combobox', { name: '場面' }).selectOption('arrived');
  await expect(page.getByRole('button', { name: '彩', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // 架空の家族が、今回に合う方法をまだ選んでいない「すること」を足す。
  await page.getByRole('button', { name: 'することを足す' }).click();
  await page.getByLabel('言ったこと（そのまま）').fill('明日8時から18時まで見守りをお願いしたい。');
  await page.getByLabel('何を（短く）').fill('明日の見守り');
  await page.getByLabel('日', { exact: true }).fill('2026-11-26');
  await page.getByLabel('始まり', { exact: true }).fill('08:00');
  await page.getByLabel('終わり', { exact: true }).fill('18:00');
  await page.getByRole('button', { name: 'この変更で変わることを見る' }).click();
  await page.getByRole('button', { name: 'この内容で保存' }).click();
  const need = page
    .locator('section')
    .filter({ hasText: '明日の見守り' })
    .filter({ has: page.getByRole('button', { name: '開く', exact: true }) });
  await need.getByRole('button', { name: '開く', exact: true }).click();

  // 新しい人とやり方を一緒に登録。分からない代償は初めのまま、見てから保存する。
  await page.getByRole('button', { name: 'やり方を足す', exact: true }).click();
  await page.getByLabel('やり方の名前').fill('近所の人に見守りを頼む');
  await page.getByLabel('何をする', { exact: true }).fill('近所の人に見守りを聞く');
  await page.getByLabel('外の相手に頼むか').selectOption('+new');
  await page.getByLabel('相手の名前').fill('架空の友人');
  await page.getByLabel('頼む文の言葉（選んでください）').selectOption('ja');
  await page.getByLabel('返事までに見込む時間').selectOption('0');
  await page.getByLabel('決まった場所').selectOption('-');
  await page.getByLabel('いつまでに').selectOption('daysBefore');
  await page
    .getByLabel('この手順をする人（外の相手なら相手）が、その時間を受け持つ', { exact: false })
    .check();
  await page.getByRole('button', { name: 'この変更で変わることを見る' }).click();
  await expect(page.getByText('計画は変わりません。')).toBeVisible();
  await page.getByRole('button', { name: 'このやり方で保存' }).click();

  // 登録した方法を選び、選んだらの応答を待って本命にする。
  const newWay = page.getByRole('checkbox', { name: /近所の人に見守りを頼む/ });
  await expect(newWay).toBeVisible();
  await expect(page.getByText(/分からない.*費用/)).toBeVisible();
  await newWay.check();
  await page.getByRole('button', { name: 'この変更で変わることを見る' }).click();
  await page.getByRole('button', { name: 'このやり方で保存' }).click();
  const primary = page.getByRole('button', { name: /^近所の人に見守りを頼む/ });
  await expect(primary).toContainText('選んだら');
  await expect(primary).toBeEnabled();
  await primary.click();

  // 実際には送らない。登録した相手への草稿と、本人の作業が出るところまで見る。
  await expect(page.getByRole('heading', { name: '送る文' })).toBeVisible();
  await expect(page.getByText('架空の友人', { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: 'きょう', exact: true }).first().click();
  const task = page.locator('section').filter({ hasText: '近所の人に見守りを聞く' });
  await expect(task).toBeVisible();
  await expect(task.getByRole('button', { name: 'やります', exact: true })).toBeVisible();
  expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
});
