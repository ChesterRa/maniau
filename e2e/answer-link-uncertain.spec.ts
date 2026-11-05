import { expect, test } from '@playwright/test';

test('保存後に応答だけ失われた時、相手の画面は結果を不明として同じ操作を確かめる', async ({ page, request }) => {
  const origin = 'http://127.0.0.1:18797';
  const made = await request.post(`${origin}/api/demo/sessions`, { data: { stage: 'arrived' } });
  const { sessionId } = await made.json() as { sessionId: string };
  const base = `${origin}/api/demo/sessions/${sessionId}`;
  let seq = 0;
  const command = async (value: Record<string, unknown>) => {
    const response = await request.post(`${base}/commands`, { data: { memberId: 'a', operationId: `uncertain-${++seq}`, command: value } });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const change = { type: 'stateNeed', text: '架空の集まり',
    interpretation: { what: '架空の集まり', shape: 'window', holdNeeded: false },
    candidates: [{ date: '2026-12-09', startTime: '13:00', endTime: '15:00' }, { date: '2026-12-11', startTime: '13:00', endTime: '15:00' }] };
  const response = await request.post(`${base}/change-preview`, { data: { memberId: 'a', command: change } });
  const { preview } = await response.json();
  const stated = await command({ ...change, seen: { throughSeq: preview.throughSeq, changes: preview.seen } });
  const itemId = stated.view.plan.requirements.find((r: { when?: unknown }) => r.when)?.basis.itemIds[0] as string | undefined;
  if (!itemId) throw new Error('item missing');
  const listed = await command({ type: 'setNeedPeople', itemId, members: [], guests: [{ name: '架空の相手' }], required: [], minCount: 1 });
  const personId = listed.view.plan.requirements.find((r: { when?: unknown }) => r.when)?.when.people[0].id as string | undefined;
  if (!personId) throw new Error('person missing');
  const issued = await command({ type: 'issueAnswerLink', itemId, personId });
  const token = issued.result.answerLink?.token as string | undefined;
  if (!token) throw new Error('test token missing');
  let intercepted = false;
  const operations: string[] = [];
  await page.route('**/api/answer', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    operations.push(route.request().postDataJSON().operationId as string);
    if (operations.length === 2) return route.fulfill({ status: 429, contentType: 'application/json', body: '{}' });
    if (intercepted) return route.continue();
    intercepted = true;
    const upstream = await route.fetch();
    expect(upstream.status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
  });
  await page.goto(`http://127.0.0.1:15183/answer#${token}`);
  await expect(page.getByText('架空の相手へ')).toBeVisible();
  await page.getByRole('button', { name: '○ はい', exact: true }).first().click();
  await expect(page.getByText('返事が届かず、届いたか分かりません。同じ答えをもう一度押すと、同じ答えとして確かめます。')).toBeVisible();
  const owner = await (await request.get(`${base}/view?member=a`)).json();
  const answers = owner.plan.requirements.find((r: { when?: unknown }) => r.when)?.when.answers as { personId: string; candidateId: string; value: string }[];
  expect(answers.find((a) => a.personId === personId && a.candidateId === 'c1')?.value).toBe('yes');
  await page.getByRole('button', { name: '○ はい', exact: true }).first().click();
  await expect(page.getByText('続けて押しすぎました。少し待ってから、もう一度押してください。')).toBeVisible();
  await page.getByRole('button', { name: '○ はい', exact: true }).first().click();
  await expect(page.getByText('答えを送りました。')).toBeVisible();
  await expect(page.getByText('今の答え：はい')).toBeVisible();
  expect(operations.length).toBe(3);
  expect(operations[0] === operations[1] && operations[1] === operations[2]).toBe(true);
  const again = await (await request.get(`${base}/view?member=a`)).json();
  expect(again.throughSeq).toBe(owner.throughSeq);
});
