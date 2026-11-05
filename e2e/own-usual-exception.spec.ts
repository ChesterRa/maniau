// 一日の答えを「ふだんどおり」に直した時に、何の記録が使われるかの確認。
import { expect, test } from '@playwright/test';

test('当日例外がある時は「ふだんどおり」を出さず、見守りだけを答えられる', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'はじめる', exact: true }).click();
  await page.getByLabel('あなたの呼び名').fill('大人A');
  await page.getByLabel('子どもの呼び名').fill('子H');
  const created = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/demo/sessions'));
  await page.getByRole('button', { name: 'この家族で始める' }).click();
  const sessionId = (await (await created).json()).sessionId as string;
  await page.getByRole('button', { name: /^例で試す/ }).click();
  await expect(page.getByRole('button', { name: '見られるかを入れる' })).toBeVisible();
  const api = `http://127.0.0.1:18797/api/demo/sessions/${sessionId}`;
  const view = async () => (await (await request.get(`${api}/view?member=a1`)).json());
  const before = await view();
  const h = {
    ...before.household,
    routines: [1, 2, 3, 4, 5].map((weekday) => ({
      memberId: 'a1', weekday, allDay: true,
      segments: [{ kind: 'home', start: '06:00', end: '23:00', viaStationIds: [] }],
    })),
    routineExceptions: [{
      memberId: 'a1', date: '2026-12-07', allDay: true,
      segments: [{ kind: 'work', start: '09:00', end: '18:00', viaStationIds: [] }],
    }],
    dayAnswers: [{ memberId: 'a1', date: '2026-12-07', can: [], cannot: [], rest: 'unknown' }],
  };
  const looked = await request.post(`${api}/household-preview`, { data: { memberId: 'a1', household: h } });
  expect(looked.status()).toBe(200);
  const { preview } = await looked.json();
  const written = await request.post(`${api}/commands`, { data: {
    memberId: 'a1', operationId: 'usual-exception-setup',
    command: { type: 'updateHousehold', household: h, seen: { throughSeq: preview.throughSeq, changes: preview.seen } },
  } });
  expect((await written.json()).result.status).toBe('ok');
  await page.reload();
  await page.getByRole('button', { name: '見られるかを入れる' }).click();
  await expect(page.getByRole('radio', { name: 'ふだんどおり' })).toHaveCount(0);
  await page.getByRole('radio', { name: '一日見られる' }).check();
  await page.getByRole('button', { name: 'これで変わることを見る' }).click();
  await page.getByRole('button', { name: '記録する', exact: true }).click();
  await expect.poll(async () => (await view()).household.dayAnswers?.[0]?.rest).toBe('can');
  const after = await view();
  const child = after.plan.arrangements.find((a: { kind: string }) => a.kind === 'childCare');
  expect(after.household.routineExceptions).toEqual(h.routineExceptions);
  expect(child).toBeUndefined();
});
