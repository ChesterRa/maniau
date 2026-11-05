// 空から始めた同じ記録に、架空の延期文を試験用の読み取りで足して取り消しまで進む。
// 実際の Claude や外部への送信は使わない。
import { expect, test } from '@playwright/test';

const postponed = '学習発表会は12月8日（火）に延期します。';

test('例から頼んだ後、延期を同じ家族に入れると取り消す文が出る', async ({ page, request }) => {
  const initialReads = (await (await request.get('http://127.0.0.1:18797/__e2e/reads')).json()).length;
  await page.goto('/');
  await page.getByRole('button', { name: 'はじめる', exact: true }).click();
  await page.getByLabel('あなたの呼び名').fill('大人A');
  await page.getByLabel('もう一人の大人（なくても大丈夫）').fill('大人B');
  await page.getByLabel('子どもの呼び名').fill('子H');
  const made = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/api/demo/sessions'),
  );
  await page.getByRole('button', { name: 'この家族で始める' }).click();
  const { sessionId } = (await (await made).json()) as { sessionId: string };
  const api = `http://127.0.0.1:18797/api/demo/sessions/${sessionId}`;
  const view = async () => (await request.get(`${api}/view?member=a1`)).json();
  await page.getByRole('button', { name: /^例で試す/ }).click();
  await page.getByRole('button', { name: '見られるかを入れる' }).click();
  await page.getByRole('radio', { name: '出社する' }).nth(0).check();
  await page.getByRole('radio', { name: '出社する' }).nth(1).check();
  await page.getByRole('radio', { name: 'ふだんどおり' }).nth(0).check();
  await page.getByRole('radio', { name: 'ふだんどおり' }).nth(1).check();
  await page.getByRole('button', { name: 'これで変わることを見る' }).click();
  await page.getByRole('button', { name: '記録する', exact: true }).click();
  await page.getByRole('button', { name: '頼める人を足す' }).click();
  await page.getByLabel('頼める人の呼び名').fill('サトウ');
  await page.getByLabel('頼むのは').selectOption('3');
  await page.getByRole('button', { name: 'これで変わることを見る' }).click();
  await page.getByRole('button', { name: 'サトウを足す' }).click();
  await page.getByRole('button', { name: 'これに決める' }).click();
  await page.getByRole('button', { name: '送ったことを記録', exact: true }).click();
  await expect(page.getByText('サトウの返事待ち', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'OK だった', exact: true }).click();
  await expect.poll(async () => (await view()).plan.requests[0]?.state).toBe('confirmed');
  const before = await view();
  const requestId = before.plan.requests[0].requestId as string;

  // これは試験用の架空文にだけ返す手書きの読み取りで、実 API の精度は見ていない。
  await page.getByRole('button', { name: 'お知らせ', exact: true }).click();
  await page.getByRole('textbox', { name: 'お知らせを入れる' }).fill(postponed);
  const added = page.waitForResponse((response) =>
    response.request().method() === 'POST' && response.url().endsWith('/notices'),
  );
  await page.getByRole('button', { name: '読み取る', exact: true }).click();
  const read = await added;
  expect(read.status()).toBe(200);
  expect(read.url()).toContain(`/sessions/${sessionId}/`);
  const { sourceId } = await read.json() as { sourceId: string };
  await expect(page.getByText(postponed, { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: 'きょう', exact: true }).first().click();

  await expect.poll(async () => (await view()).plan.requests.find(
    (entry: { requestId: string }) => entry.requestId === requestId,
  )?.live).toBe(false);
  const changed = await view();
  expect(changed.sources.find((source: { id: string }) => source.id === sourceId).sentences[0].text)
    .toBe(postponed);
  expect(changed.today.main.map((card: { kind: string }) => card.kind)).toContain('cancel');
  expect(changed.notificationPreview.blockedAll).toBe(false);
  await expect(page.getByText('もう要らないこと', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '伝える文を見る' }).first().click();
  await expect(page.getByText('サトウ', { exact: false }).first()).toBeVisible();
  // 架空のテストとして「伝えた」と記録する。外部アプリや実際の人には送らない。
  await page.getByRole('button', { name: '取り消しを伝えた', exact: true }).click();
  await expect.poll(async () => (await view()).plan.requests.find(
    (entry: { requestId: string }) => entry.requestId === requestId,
  )?.state).toBe('cancelled');
  const completed = await view();
  expect(completed.today.main.map((card: { kind: string }) => card.kind)).not.toContain('cancel');
  expect(completed.notificationPreview.blockedAll).toBe(false);
  expect((await (await request.get('http://127.0.0.1:18797/__e2e/reads')).json())
    .slice(initialReads).map((call: { text: string }) => call.text)).toEqual([postponed]);
  expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
});
