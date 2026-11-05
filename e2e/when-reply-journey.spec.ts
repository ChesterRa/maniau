import { expect, test } from '@playwright/test';

test('相手の答えが届いた後、家族の表はその答えを見られる', async ({ page, browser, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '用意した場面で見る（審査の方へ）' }).click();
  await expect(page.getByRole('combobox', { name: '場面' })).toBeVisible();
  const created = page.waitForResponse((r) => r.url().endsWith('/api/demo/sessions') && r.request().method() === 'POST' && r.request().postDataJSON()?.stage === 'when');
  await page.getByRole('combobox', { name: '場面' }).selectOption('when');
  const { sessionId } = await (await created).json() as { sessionId: string };
  await page.getByRole('button', { name: '陽菜を見てもらう：答えを集めています（候補 2 つ）' }).click();
  const sato = page.getByText('近所のサトウさん：リンクを出しています', { exact: true }).locator('..');
  await sato.getByRole('button', { name: '出し直す' }).click();
  const url = await sato.locator('input[readonly]').inputValue();
  expect(url.includes('/answer#')).toBe(true);
  const row = page.locator('table tbody tr').nth(1);
  const satoColumn = await page.getByRole('columnheader', { name: '近所のサトウさん' })
    .evaluate((header) => (header as HTMLTableCellElement).cellIndex);
  await expect(row.locator('td').nth(satoColumn - 1)).toHaveText('ー');
  const guest = await browser.newContext({ locale: 'ja-JP', viewport: { width: 390, height: 844 } });
  try {
    const answer = await guest.newPage();
    await answer.goto(url);
    await expect(answer.getByText('近所のサトウさんへ')).toBeVisible();
    await answer.getByRole('button', { name: '○ はい', exact: true }).nth(1).click();
    await expect(answer.getByText('答えを送りました。')).toBeVisible();
    const owner = await (await request.get(`http://127.0.0.1:18797/api/demo/sessions/${sessionId}/view?member=b`)).json();
    const answers = owner.plan.requirements.find((r: { when?: unknown }) => r.when)?.when.answers as { personId: string; candidateId: string; value: string }[];
    expect(answers.find((a) => a.personId === 'g-sato' && a.candidateId === 'c2')?.value).toBe('yes');
    await page.getByRole('button', { name: 'きょう', exact: true }).first().click();
    await page.getByRole('button', { name: '陽菜を見てもらう：答えを集めています（候補 2 つ）' }).click();
    await page.getByRole('button', { name: '最新の答えを読む' }).click();
    await expect(row.locator('td').nth(satoColumn - 1)).toHaveText('○');
    const card = page.locator('section').filter({ has: page.getByRole('heading', { name: /12\/13.*13:00/ }) });
    await card.getByRole('button', { name: 'この日に決めたら変わることを見る' }).click();
    await card.getByRole('button', { name: 'この日に決める', exact: true }).click();
    await expect(page.getByText('決めた日', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'この日の手配を見る' }).click();
    await expect(page.getByText('祖母に来てもらう', { exact: false }).first()).toBeVisible();
    expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
  } finally {
    await guest.close();
  }
});
