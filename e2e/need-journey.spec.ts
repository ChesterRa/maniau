import { expect, test } from '@playwright/test';

test('「すること」を足し、やり方を選んで、頼んだ後の返事を待つ', async ({ page, request }) => {
  test.setTimeout(90_000);

  // 架空のデモで、家族の言葉と、計算に使う日時・対象を別々に入れる。
  await page.goto('/');
  await page.getByRole('button', { name: '用意した場面で見る（審査の方へ）' }).click();
  await page.getByRole('combobox', { name: '場面' }).selectOption('arrived');
  await expect(page.getByRole('button', { name: '彩', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'することを足す' }).click();
  await page.getByLabel('言ったこと（そのまま）').fill(
    '陽菜が熱っぽいので、あしたは8時から18時まで、だれか家にいてほしい',
  );
  await page.getByLabel('何を（短く）').fill('陽菜を家で見る');
  await page.getByLabel('日', { exact: true }).fill('2026-11-26');
  await page.getByLabel('始まり', { exact: true }).fill('08:00');
  await page.getByLabel('終わり', { exact: true }).fill('18:00');
  await page.getByLabel('だれのため（任意）').selectOption({ label: '陽菜' });
  await page.getByRole('button', { name: 'この変更で変わることを見る' }).click();
  await page.getByRole('button', { name: 'この内容で保存' }).click();

  const need = page
    .locator('section')
    .filter({ hasText: '陽菜を家で見る' })
    .filter({ has: page.getByRole('button', { name: '開く', exact: true }) });
  await expect(need).toBeVisible();
  await need.getByRole('button', { name: '開く', exact: true }).click();
  await page.getByRole('checkbox', { name: /病児保育に預ける/ }).check();
  await page.getByRole('checkbox', { name: /祖母に来てもらう/ }).check();
  await page.getByRole('button', { name: 'この変更で変わることを見る' }).click();
  await page.getByRole('button', { name: 'このやり方で保存' }).click();

  // 「おすすめ」が先に出ても、各案の「選んだら」を読み終えるまでは選べない。
  // ここで実際のプレビュー応答を待ち、読み込み失敗で選べない退行も見つける。
  const grandma = page.getByRole('button', { name: /^祖母に来てもらう/ });
  const care = page.getByRole('button', { name: /^病児保育に預ける/ });
  await expect(grandma).toContainText('選んだら');
  await expect(care).toContainText('選んだら');
  await expect(grandma).toBeEnabled();
  await expect(care).toBeEnabled();
  await expect(grandma).toContainText('20:55');
  await expect(care).toContainText('20:50');
  await expect(page.getByText('「選んだら」を読めませんでした。', { exact: false })).toHaveCount(0);
  await grandma.click();

  // 選んだ人の頼む文を確認し、きょうに戻ると、その人だけに作業が提案されている。
  await expect(page.getByRole('heading', { name: '送る文' })).toBeVisible();
  await expect(page.getByText('学校がお休み', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'きょう', exact: true }).first().click();
  const task = page.locator('section').filter({ hasText: '祖母に来てもらえるか聞く' });
  await expect(task).toBeVisible();
  await expect(task.getByRole('button', { name: 'やります', exact: true })).toBeVisible();
  const kentaView = page.waitForResponse(
    (response) => response.url().includes('/view?member=a') && response.status() === 200,
  );
  await page.getByRole('button', { name: '健太', exact: true }).click();
  await kentaView;
  await expect(page.getByRole('button', { name: '健太', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // 健太には、彩がまだ引き受けていない作業として静かに見えるが、健太が代わりに引き受ける押し口は出ない。
  await expect(task).toBeVisible();
  await expect(task.getByText('彩さんが、まだ引き受けていません')).toBeVisible();
  await expect(task.getByRole('button', { name: 'やります', exact: true })).toHaveCount(0);

  const ayaView = page.waitForResponse(
    (response) => response.url().includes('/view?member=b') && response.status() === 200,
  );
  await page.getByRole('button', { name: '彩', exact: true }).click();
  await ayaView;
  await expect(task).toBeVisible();
  await task.getByRole('button', { name: 'やります', exact: true }).click();
  await page.getByRole('button', { name: '送る', exact: true }).click();
  await expect(page.getByRole('heading', { name: '送る文' })).toBeVisible();

  // 本当の相手には送らず、送ったという架空の操作を記録する。返事はまだ確定しない。
  await page.getByRole('button', { name: '送ったことを記録', exact: true }).click();
  await expect(page.getByText(/おばあちゃんの返事待ち/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'OK だった', exact: true })).toBeVisible();
  await expect(
    page.getByText('まだだれが受け持つかを確かめられていません', { exact: false }),
  ).toBeVisible();
  expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
});
