import { expect, test } from '@playwright/test';

test('送った「すること」の直し・取り消しを、変わることを見てから決める', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);

  // 架空の家庭で窓型の用件を足し、祖母を本命にして「送った」「OK だった」を記録する。
  await page.goto('/');
  await page.getByRole('button', { name: '用意した場面で見る（審査の方へ）' }).click();
  await page.getByRole('combobox', { name: '場面' }).selectOption('arrived');
  await page.getByRole('button', { name: 'することを足す' }).click();
  await page.getByRole('button', { name: '時間を決めてだれかが要る時は、詳しく入れる' }).click();
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
  await need.getByRole('button', { name: '開く', exact: true }).click();
  await page.getByRole('checkbox', { name: /祖母に来てもらう/ }).check();
  await page.getByRole('button', { name: 'この変更で変わることを見る' }).click();
  await page.getByRole('button', { name: 'このやり方で保存' }).click();
  const grandma = page.getByRole('button', { name: /^祖母に来てもらう/ });
  await expect(grandma).toBeEnabled();
  await grandma.click();

  await expect(page.getByRole('heading', { name: '送る文' })).toBeVisible();
  await page.getByRole('button', { name: 'きょう', exact: true }).first().click();
  const task = page.locator('section').filter({ hasText: '祖母に来てもらえるか聞く' });
  await task.getByRole('button', { name: 'やります', exact: true }).click();
  await page.getByRole('button', { name: '送る', exact: true }).click();
  await page.getByRole('button', { name: '送ったことを記録', exact: true }).click();
  await page.getByRole('button', { name: 'OK だった', exact: true }).click();
  await expect(page.getByRole('button', { name: 'OK だった', exact: true })).toHaveCount(0);

  // 日と「だれのため」を直す前に、選び直しと送った相手への確かめを見せる。
  await page.getByRole('button', { name: /^陽菜を家で見る（/ }).click();
  await page.getByRole('button', { name: '中身を直す', exact: true }).click();
  await page.getByLabel('日', { exact: true }).fill('2026-11-27');
  await page.getByLabel('だれのため（任意）').selectOption({ label: '選ばない' });
  await page.getByRole('button', { name: 'この変更で変わることを見る', exact: true }).click();
  await expect(
    page.getByText('おばあちゃんへの頼み事は、頼んだ時と時間や根拠が変わるので、相手に確かめが要ります。'),
  ).toBeVisible();
  await expect(
    page.getByText('「陽菜を家で見る」：やり方が変わったので、選び直しが要ります。'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'この内容で保存', exact: true }).click();
  await expect(page.getByText('だれのため：陽菜', { exact: true })).toHaveCount(0);

  // 要らないにする前に取り消しを知らせ、文は今の日ではなく送った日の控えを使う。
  await page.getByRole('button', { name: '要らないにする', exact: true }).click();
  const dismiss = page.locator('section').filter({ hasText: 'この「すること」を要らないにする' });
  await dismiss.getByRole('button', { name: 'この変更で変わることを見る', exact: true }).click();
  await expect(dismiss.getByText('おばあちゃんへの取り消しの連絡が要ります。')).toBeVisible();
  await dismiss.getByRole('button', { name: '要らないにする', exact: true }).click();
  const cancel = page.locator('section').filter({ hasText: '予定が変わりました。取り消しを伝えてください。' });
  await cancel.getByRole('button', { name: '伝える文を見る', exact: true }).click();
  await expect(cancel).toContainText('11月26日（木）');
  await expect(cancel).not.toContainText('11月27日（金）');
  expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
});
