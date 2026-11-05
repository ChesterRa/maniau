import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

test('決める・選び直す・取り消しを伝える主線', async ({ page, request }) => {
  test.setTimeout(90_000);
  const output = fileURLToPath(new URL('../.local/e2e-results/decision/', import.meta.url));
  await mkdir(output, { recursive: true });
  const shot = async (name: string) => {
    // 画像の見た目だけでなく、横スクロールを要する崩れも確かめる。
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${output}${name}.png` });
  };
  const show = async (locator: ReturnType<typeof page.getByRole>) => {
    await locator.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => window.scrollBy(0, -12));
  };

  // 1. 通知が届いた時：彩の「きょう」から決める画面へ。
  await page.goto('/');
  await page.getByRole('button', { name: '用意した場面で見る（審査の方へ）' }).click();
  await page.getByRole('combobox', { name: '場面' }).selectOption('arrived');
  await expect(page.getByText('デモの時計 11/25', { exact: false })).toBeVisible();
  await expect(page.getByText('ひとこと', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '子どもの見守り方を選ぶ', exact: true })).toBeVisible();
  await shot('01-today');
  await page.getByRole('button', { name: '子どもの見守り方を選ぶ', exact: true }).click();
  await expect(page.getByText('学習発表会の実施日が12/5（土）なら要ります', { exact: false })).toBeVisible();
  const school = page.getByRole('button', { name: /^学童に預ける/ });
  const grandma = page.getByRole('button', { name: /^おばあちゃんに頼む/ });
  await expect(school).toBeEnabled();
  await shot('02-choice');

  // 2. 決め時の要約と内訳。
  await expect(page.getByText('いま選べる手は4つ', { exact: false })).toBeVisible();
  await page.getByText('手ごとの残りを見る').click();
  await expect(page.getByText('手ごとの残りを見る')).toBeVisible();
  await shot('03-clock');

  // 3–4. 一つのおすすめ、祖母の返事の期限、それぞれを選んだ後の見通し。
  await expect(page.getByText('おすすめ', { exact: true })).toHaveCount(1);
  await expect(school).toContainText('選んだら');
  await expect(school).toContainText('学童の申込書を書く');
  await show(school);
  await shot('04-recommendation');
  await expect(grandma).toContainText('11/29（日）の夜までに返事');
  await expect(grandma).toContainText('返事を待ちます');
  await show(grandma);
  await shot('05-grandma');

  // 5. 一日進むと、彩ではなく健太への提案になる。
  await page.getByRole('button', { name: '+1日', exact: true }).click();
  await expect(page.getByText('デモの時計 11/26', { exact: false })).toBeVisible();
  await expect(school).toContainText('健太さんに作業を提案します');
  await expect(school).toContainText('11/30（月） 17:20');
  await show(school);
  await shot('06-next-day');

  // 6. 返事待ちから別の手を選ぶ。選ぶ前に取り消しを示し、選んだ後に草稿が見える。
  await page.getByRole('combobox', { name: '場面' }).selectOption('chase');
  await expect(page.getByText('念のため', { exact: true })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('07-waiting');
  await page.getByRole('button', { name: 'ほかの手も見る・選び直す' }).click();
  await expect(school).toBeEnabled();
  await expect(school).toContainText('健太さんに作業を提案します');
  await expect(school).toContainText('取り消しを伝える作業が出ます');
  await show(school);
  await shot('08-change-preview');
  await school.click();
  const cancellation = page.getByText('もう要らないこと', { exact: true });
  await expect(cancellation).toBeVisible();
  const draft = page.getByRole('button', { name: '伝える文を見る' });
  await show(cancellation);
  await shot('09-cancel');
  await draft.click();
  await expect(page.getByRole('button', { name: 'LINE などで共有' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'コピー', exact: true })).toBeVisible();
  await show(cancellation);
  await shot('10-cancel-draft');
  await page.getByRole('button', { name: '健太', exact: true }).click();
  const write = page.getByText('学童の申込書を書く', { exact: false }).first();
  await expect(write).toBeVisible();
  await show(page.getByText('おねがい', { exact: true }).first());
  await shot('11-kenta');

  // 画面の読み取り欄は有効でも、主線の試験中にモデルを呼ばない。
  expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
});
