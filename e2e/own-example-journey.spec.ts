// 試用の架空の家族と例文で、分からない所を聞き、頼んだ後まで進む。
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

test('例から、分からない見守りを聞く', async ({ page, request }) => {
  const output = fileURLToPath(new URL('../.local/e2e-results/own/', import.meta.url));
  await mkdir(output, { recursive: true });
  const shot = async (name: string) => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${output}${name}.png` });
  };
  // 実際のクリップボードや外部アプリに触れず、コピーを押した時の画面と記録だけを確かめる。
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => undefined },
    });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'はじめる', exact: true })).toBeVisible();
  await shot('01-welcome');
  await page.getByRole('button', { name: 'はじめる', exact: true }).click();
  await page.getByLabel('あなたの呼び名').fill('大人A');
  await page.getByLabel('もう一人の大人（なくても大丈夫）').fill('大人B');
  await page.getByLabel('子どもの呼び名').fill('子H');
  const created = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/demo/sessions'));
  await page.getByRole('button', { name: 'この家族で始める' }).click();
  const sessionId = (await (await created).json()).sessionId as string;
  await expect(page.getByText('まだお知らせがありません')).toBeVisible();
  await shot('02-empty');
  const added = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/example-notice'));
  await page.getByRole('button', { name: /^例で試す/ }).click();
  expect((await added).status()).toBe(200);
  await expect(page.getByText(/見られるか/).first()).toBeVisible();
  await shot('03-facts-card');
  const view = await (await request.get(`http://127.0.0.1:18797/api/demo/sessions/${sessionId}/view?member=a1`)).json();
  expect(view.today.main.map((c: { kind: string }) => c.kind)).toContain('facts');
  expect(view.plan.arrangements.filter((a: { kind: string }) => a.kind === 'childCare')).toEqual([]);
  expect(JSON.stringify(view.household.members)).not.toMatch(/健太|彩|陽菜/);
  await page.getByRole('button', { name: '見られるかを入れる' }).click();
  await expect(page.getByText('この時間の前と後は家にいて、子を見られる', { exact: false })).toHaveCount(0);
  await page.getByRole('radio', { name: '出社する' }).nth(0).check();
  await shot('04-facts-entry');
  await page.getByRole('radio', { name: '出社する' }).nth(1).check();
  await expect(page.getByText('この時間の前と後は家にいて、子を見られる', { exact: false })).toHaveCount(2);
  await page.getByRole('radio', { name: 'ふだんどおり' }).nth(0).check();
  await page.getByRole('radio', { name: 'ふだんどおり' }).nth(1).check();
  await page.getByRole('button', { name: 'これで変わることを見る' }).click();
  const unchanged = await (await request.get(`http://127.0.0.1:18797/api/demo/sessions/${sessionId}/view?member=a1`)).json();
  expect(unchanged.household.routines).toEqual([]);
  await page.getByRole('button', { name: '記録する', exact: true }).click();
  await expect(page.getByRole('button', { name: '取れる手を足す' })).toBeVisible();
  await page.getByRole('button', { name: '取れる手を足す' }).click();
  await page.getByLabel('頼める人の呼び名').fill('サトウ');
  await expect(page.getByRole('button', { name: 'これで変わることを見る' })).toBeDisabled();
  await page.getByLabel('頼むのは').selectOption('3');
  await page.getByRole('button', { name: 'これで変わることを見る' }).click();
  await page.getByRole('button', { name: '「サトウ」を足す' }).click();
  await expect(page.getByText('「サトウ」を足しました', { exact: false })).toBeVisible();
  const withHelper = await (await request.get(`http://127.0.0.1:18797/api/demo/sessions/${sessionId}/view?member=a1`)).json();
  expect(withHelper.household.careOptions[0]?.deadline).toEqual({ type: 'daysBefore', days: 3, at: '21:00' });
  await page.getByRole('button', { name: 'これに決める' }).click();
  await expect(page.getByRole('button', { name: '送ったことを記録', exact: true })).toBeVisible();
  const chosen = await (await request.get(`http://127.0.0.1:18797/api/demo/sessions/${sessionId}/view?member=a1`)).json();
  expect(chosen.plan.requests).toEqual([]);
  await shot('05-draft');
  await page.getByRole('button', { name: 'コピー', exact: true }).click();
  await expect(page.getByText('コピーしました', { exact: false })).toBeVisible();
  const copied = await (await request.get(`http://127.0.0.1:18797/api/demo/sessions/${sessionId}/view?member=a1`)).json();
  expect(copied.plan.requests).toEqual([]);
  expect(copied.throughSeq).toBe(chosen.throughSeq);
  await page.getByRole('button', { name: '送ったことを記録', exact: true }).click();
  await expect.poll(async () => {
    const latest = await (await request.get(`http://127.0.0.1:18797/api/demo/sessions/${sessionId}/view?member=a1`)).json();
    return latest.plan.requests.length;
  }).toBe(1);
  await expect(page.getByText('サトウの返事待ち', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: '頼んだこと', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('送ったと記録しました');
  await page.evaluate(() => window.scrollTo(0, 0));
  // 押した直後、固定の下帯に隠れず、だれの返事を待つかを見られる。
  const waitingRow = await page.getByText('サトウの返事待ち', { exact: false }).boundingBox();
  const bottomNav = await page.getByRole('navigation').boundingBox();
  expect(waitingRow && bottomNav && waitingRow.y + waitingRow.height <= bottomNav.y).toBe(true);
  await shot('06-waiting');
  await page.reload();
  await expect(page.getByText('サトウの返事待ち', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('maniau.trial.v1'))).toBe(sessionId);
  const waiting = await (await request.get(`http://127.0.0.1:18797/api/demo/sessions/${sessionId}/view?member=a1`)).json();
  expect(waiting.plan.requests[0].state).toBe('awaitingReply');
  const imagined = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/change-preview'));
  await page.getByRole('button', { name: '断られたら？' }).click();
  expect((await imagined).status()).toBe(200);
  await expect(page.getByText('まだ断っていません', { exact: false })).toBeVisible();
  const afterPreview = await (await request.get(`http://127.0.0.1:18797/api/demo/sessions/${sessionId}/view?member=a1`)).json();
  expect(afterPreview.throughSeq).toBe(waiting.throughSeq);
  expect(afterPreview.plan.requests[0].state).toBe('awaitingReply');
  await page.getByRole('button', { name: 'きょう', exact: true }).first().click();
  await page.getByRole('button', { name: 'OK だった', exact: true }).click();
  await expect.poll(async () => {
    const latest = await (await request.get(`http://127.0.0.1:18797/api/demo/sessions/${sessionId}/view?member=a1`)).json();
    return latest.plan.requests[0].state;
  }).toBe('confirmed');
  await expect(page.getByRole('status')).toHaveText('OK の返事を記録しました。');
  await expect(page.getByRole('heading', { name: '決まったこと', exact: true })).toBeVisible();
  await expect(page.getByText('サトウから OK の返事', { exact: true })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('07-confirmed');
  expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
});
