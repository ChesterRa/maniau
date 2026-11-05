// 入れていない時間を「見られる」と決めない。架空の家族とお知らせだけを使う。
import { expect, test, type Page, type APIRequestContext } from '@playwright/test';

async function begin(page: Page): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: 'はじめる', exact: true }).click();
  await page.getByLabel('あなたの呼び名').fill('大人A');
  await page.getByLabel('もう一人の大人（なくても大丈夫）').fill('大人B');
  await page.getByLabel('子どもの呼び名').fill('子H');
  const created = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/demo/sessions'));
  await page.getByRole('button', { name: 'この家族で始める' }).click();
  const sessionId = (await (await created).json()).sessionId as string;
  await page.getByRole('button', { name: /^例で試す/ }).click();
  await page.getByRole('button', { name: '見られるかを入れる' }).click();
  return sessionId;
}

async function view(request: APIRequestContext, sessionId: string) {
  return (await (await request.get(`http://127.0.0.1:18797/api/demo/sessions/${sessionId}/view?member=a1`)).json());
}

test('見られない時間だけを答え、残りを選んでいない時は分からないまま', async ({ page, request }) => {
  const sessionId = await begin(page);
  await page.getByRole('radio', { name: '見られない時間がある' }).first().check();
  const rest = page.getByRole('combobox').last();
  await expect(rest).toHaveValue('unknown');
  await page.getByRole('button', { name: 'これで変わることを見る' }).click();
  await page.getByRole('button', { name: '記録する', exact: true }).click();
  await expect.poll(async () => (await view(request, sessionId)).household.dayAnswers?.length).toBe(1);
  const current = await view(request, sessionId);
  expect(current.household.dayAnswers[0].rest).toBe('unknown');
  expect(current.plan.requirements.find((r: { kind: string }) => r.kind === 'childCare').unsure).toEqual([
    { start: '2026-12-07T00:00+09:00', end: '2026-12-08T00:00+09:00' },
  ]);
});

test('A は 9–12、B は 13–18 だけ見られる：間の 12–13 は不明のまま', async ({ page, request }) => {
  const sessionId = await begin(page);
  await page.getByRole('radio', { name: '見られる時間だけ分かる' }).nth(0).check();
  await page.getByRole('radio', { name: '見られる時間だけ分かる' }).nth(1).check();
  await page.getByLabel('始まり').nth(1).fill('13:00');
  await page.getByLabel('終わり').nth(1).fill('18:00');
  await page.getByRole('button', { name: 'これで変わることを見る' }).click();
  await page.getByRole('button', { name: '記録する', exact: true }).click();
  await expect.poll(async () => (await view(request, sessionId)).household.dayAnswers?.length).toBe(2);
  const current = await view(request, sessionId);
  const care = current.plan.requirements.find((r: { kind: string }) => r.kind === 'childCare');
  expect(care.missingAdults).toEqual(['a1', 'a2']);
  expect(care.unsure).toContainEqual({ start: '2026-12-07T12:00+09:00', end: '2026-12-07T13:00+09:00' });
  expect(current.plan.arrangements.filter((a: { kind: string }) => a.kind === 'childCare')).toEqual([]);
  await expect(page.getByRole('button', { name: '見られるかを入れる' })).toBeVisible();
});
