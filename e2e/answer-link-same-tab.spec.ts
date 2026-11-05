import { expect, test } from '@playwright/test';

test('同じタブで別の相手のリンクを開いた時、そのリンクの頁に切り替わる', async ({ page, request }) => {
  const origin = 'http://127.0.0.1:18797';
  const made = await request.post(`${origin}/api/demo/sessions`, { data: { stage: 'arrived' } });
  expect(made.status()).toBe(200);
  const { sessionId } = await made.json() as { sessionId: string };
  const base = `${origin}/api/demo/sessions/${sessionId}`;
  let seq = 0;
  const command = async (value: Record<string, unknown>) => {
    const response = await request.post(`${base}/commands`, { data: { memberId: 'a', operationId: `same-tab-${++seq}`, command: value } });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const change = { type: 'stateNeed', text: '架空の集まり',
    interpretation: { what: '架空の集まり', shape: 'window', holdNeeded: false },
    candidates: [{ date: '2026-12-09', startTime: '13:00', endTime: '15:00' },
      { date: '2026-12-11', startTime: '13:00', endTime: '15:00' }] };
  const response = await request.post(`${base}/change-preview`, { data: { memberId: 'a', command: change } });
  const { preview } = await response.json();
  const stated = await command({ ...change, seen: { throughSeq: preview.throughSeq, changes: preview.seen } });
  const itemId = stated.view.plan.requirements.find((r: { when?: unknown }) => r.when)?.basis.itemIds[0] as string | undefined;
  if (!itemId) throw new Error('item missing');
  const listed = await command({ type: 'setNeedPeople', itemId, members: [], guests: [{ name: '架空の相手 A' }, { name: '架空の相手 B' }], required: [], minCount: 1 });
  const people = listed.view.plan.requirements.find((r: { when?: unknown }) => r.when)?.when.people as { id: string; name: string }[];
  const personA = people.find((p) => p.name === '架空の相手 A')?.id;
  const personB = people.find((p) => p.name === '架空の相手 B')?.id;
  if (!personA || !personB) throw new Error('people missing');
  const issuedA = await command({ type: 'issueAnswerLink', itemId, personId: personA });
  const issuedB = await command({ type: 'issueAnswerLink', itemId, personId: personB });
  const tokenA = issuedA.result.answerLink?.token as string | undefined;
  const tokenB = issuedB.result.answerLink?.token as string | undefined;
  if (!tokenA || !tokenB) throw new Error('test tokens missing');
  await page.goto(`http://127.0.0.1:15183/answer#${tokenA}`);
  await expect(page.getByText('架空の相手 Aへ')).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe('');
  await page.goto(`http://127.0.0.1:15183/answer#${tokenB}`);
  await expect(page.getByText('架空の相手 Bへ')).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe('');
  await page.getByRole('button', { name: '○ はい', exact: true }).first().click();
  await expect(page.getByText('答えを送りました。')).toBeVisible();
  const owner = await (await request.get(`${base}/view?member=a`)).json();
  const answers = owner.plan.requirements.find((r: { when?: unknown }) => r.when)?.when.answers as { personId: string; value: string }[];
  expect(answers.find((a) => a.personId === personB)?.value).toBe('yes');
  expect(answers.find((a) => a.personId === personA)).toBeUndefined();
});
