// 架空の場面で、原文を残してお知らせを計画から外し、既に送った依頼を家族が確かめる。
// 外部の読み取りや地図は呼ばない（試験用サーバーの呼び出し数も確かめる）。
import { expect, test } from '@playwright/test';
import { proposalSnapshot } from '../packages/core/src/index';

for (const lang of ['ja', 'en'] as const) {
  test(`お知らせを外した後の依頼を、控えを見て残す (${lang})`, async ({ page, request }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await page.getByRole('button', { name: '用意した場面で見る（審査の方へ）' }).click();
    if (lang === 'en') await page.getByRole('button', { name: 'English', exact: true }).click();
    const created = page.waitForResponse((response) =>
      response.request().method() === 'POST' && response.url().endsWith('/api/demo/sessions') &&
      response.request().postDataJSON()?.stage === 'chase',
    );
    await page.getByRole('combobox', { name: lang === 'ja' ? '場面' : 'Scene' }).selectOption('chase');
    const { sessionId } = (await (await created).json()) as { sessionId: string };
    const read = async () => (await request.get(`http://127.0.0.1:18797/api/demo/sessions/${sessionId}/view?member=b`)).json();
    const prior = await read();
    const original = prior.sources.find((source: { id: string }) => source.id === 'n1');
    expect(original).toBeTruthy();
    await page.getByRole('button', { name: lang === 'ja' ? 'お知らせ' : 'Notices', exact: true }).click();
    const section = page.locator('details').filter({
      has: page.locator('summary').getByText(lang === 'ja' ? 'お知らせを計画から外す' : 'Remove this notice from the plan'),
    }).first();
    await section.locator('summary').click();
    await expect(section.getByText(lang === 'ja' ? '計画から外した後は、元に戻せません。' : 'Removing it from the plan cannot be undone.')).toBeVisible();
    await section.getByRole('radio', { name: lang === 'ja' ? '読み取りが間違っている' : 'The reading is wrong' }).check();
    await section.getByRole('button', { name: lang === 'ja' ? '変わることを見る' : 'See what changes' }).click();
    await section.getByRole('button', { name: lang === 'ja' ? '計画から外す' : 'Remove from the plan' }).click();
    await expect.poll(async () => (await read()).excludedSources).toContainEqual({ sourceId: 'n1', reason: 'misread' });
    const excluded = await read();
    expect(excluded.sources.find((source: { id: string }) => source.id === 'n1').sentences).toEqual(original.sentences);
    expect(excluded.plan.requests.find((item: { requestId: string }) => item.requestId === 'r-grandma'))
      .toMatchObject({ live: true, needsCheck: true });
    expect(excluded.plan.tasks.some((task: { live: boolean; cancels?: string }) => task.live && task.cancels === 'r-grandma')).toBe(false);
    await page.getByRole('button', { name: lang === 'ja' ? 'きょう' : 'Today', exact: true }).first().click();
    await page.getByRole('button', { name: lang === 'ja' ? 'このお願いはまだ要る' : 'Still need this request' }).click();
    await expect.poll(async () => (await read()).plan.requests.find(
      (item: { requestId: string }) => item.requestId === 'r-grandma',
    )?.standalone).toBe(true);
    const kept = await read();
    expect(kept.plan.requests.find((item: { requestId: string }) => item.requestId === 'r-grandma').needsCheck).not.toBe(true);
    expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
    expect(errors).toEqual([]);
  });
}

test('元の文と見比べて日付を直し、前の日に送った依頼は確かめる', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '用意した場面で見る（審査の方へ）' }).click();
  const created = page.waitForResponse((response) =>
    response.request().method() === 'POST' && response.url().endsWith('/api/demo/sessions') &&
    response.request().postDataJSON()?.stage === 'chase',
  );
  await page.getByRole('combobox', { name: '場面' }).selectOption('chase');
  const { sessionId } = (await (await created).json()) as { sessionId: string };
  const read = async () => (await request.get(`http://127.0.0.1:18797/api/demo/sessions/${sessionId}/view?member=b`)).json();
  await page.getByRole('button', { name: 'お知らせ', exact: true }).click();
  const edits = page.locator('details').filter({ has: page.locator('summary').getByText('読み取った日付を直す') }).first();
  await edits.locator('summary').click();
  const day = edits.locator('div.rounded-xl').filter({ hasText: '5日(土)に行った場合、12月7日(月)は振替休業日です。' });
  await expect(day).toHaveCount(1);
  await day.getByLabel('正しい日付').fill('2026-12-14');
  await day.getByRole('button', { name: '変わることを見る' }).click();
  await day.getByRole('button', { name: 'この日付で記録する' }).click();
  await expect.poll(async () => (await read()).items.find(
    (entry: { item: { id: string } }) => entry.item.id === 'n1:i6',
  )?.item.interpretation.date).toBe('2026-12-14');
  const after = await read();
  expect(after.plan.requests.find((item: { requestId: string }) => item.requestId === 'r-grandma'))
    .toMatchObject({ live: true, needsCheck: true });
  expect(after.plan.tasks.some((task: { live: boolean; cancels?: string }) => task.live && task.cancels === 'r-grandma')).toBe(false);
  expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
});

test('二人の端末が前後しても、外で送った文は戻った画面から元の控えで記録できる', async ({ page, request }) => {
  await page.goto('/');
  const made = page.waitForResponse((response) =>
    response.request().method() === 'POST' && response.url().endsWith('/api/demo/sessions'),
  );
  await page.getByRole('button', { name: '用意した場面で見る（審査の方へ）' }).click();
  const { sessionId } = (await (await made).json()) as { sessionId: string };
  const api = `http://127.0.0.1:18797/api/demo/sessions/${sessionId}`;
  const view = async (member: string) => (await request.get(`${api}/view?member=${member}`)).json();
  const send = async (memberId: string, operationId: string, command: unknown) => {
    const response = await request.post(`${api}/commands`, { data: { memberId, operationId, command } });
    expect(response.status()).toBe(200);
    expect((await response.json()).result.status).toBe('ok');
  };
  const key = 'arr:childCare:n1:i6:c';
  const optionKey = `opt:${key}:opt-grandma`;
  await send('b', 'stale-choose', { type: 'chooseOption', arrangementKey: key, optionKey,
    role: 'primary', assigneeId: 'a' });
  const first = await view('a');
  const task = first.plan.tasks.find((entry: { key: string }) => entry.key === `task:${optionKey}:ask`);
  const shown = task && proposalSnapshot(task);
  if (!task || !shown) throw Error('提案が無い');
  await send('a', 'stale-accept', { type: 'accept', taskKey: task.key, shown });
  await page.getByRole('button', { name: '健太', exact: true }).click();
  await page.getByRole('button', { name: '送る', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: '送る文' })).toBeVisible();

  // 別の大人が、相手に送ったかをまだ記録する前に、加え間違いを外した。
  const change = { type: 'discardSource', sourceId: 'n1', reason: 'misfiled' };
  const response = await request.post(`${api}/change-preview`, { data: { memberId: 'b', command: change } });
  const { preview } = await response.json();
  await send('b', 'stale-discard', { ...change, seen: { throughSeq: preview.throughSeq, changes: preview.seen } });
  // 外部アプリから戻ると、画面は家庭の現在を読み直す。
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByText('この作業は、今の計画では進められません。', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'コピー', exact: true })).toHaveCount(0);
  const recorded = page.waitForResponse((result) =>
    result.request().method() === 'POST' && result.url().endsWith('/commands') &&
    result.request().postDataJSON()?.command?.type === 'recordSent',
  );
  await page.getByRole('button', { name: '送ったことを記録' }).click();
  const result = await recorded;
  expect((await result.json()).result.status).toBe('ok');
  const command = result.request().postDataJSON().command;
  expect(command.shown.throughSeq).toBeLessThanOrEqual(preview.throughSeq);
  const after = await view('a');
  expect(after.plan.requests.find((entry: { requestId: string }) => entry.requestId === command.requestId))
    .toMatchObject({ live: true, needsCheck: true });
  expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
});

test('もう一人が日付を直しても、前に送った文は前の日の控えで記録する', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const made = page.waitForResponse((response) =>
    response.request().method() === 'POST' && response.url().endsWith('/api/demo/sessions'),
  );
  await page.getByRole('button', { name: '用意した場面で見る（審査の方へ）' }).click();
  const { sessionId } = (await (await made).json()) as { sessionId: string };
  const api = `http://127.0.0.1:18797/api/demo/sessions/${sessionId}`;
  const view = async (member: string) => (await request.get(`${api}/view?member=${member}`)).json();
  const send = async (memberId: string, operationId: string, command: unknown) => {
    const response = await request.post(`${api}/commands`, { data: { memberId, operationId, command } });
    expect(response.status()).toBe(200);
    expect((await response.json()).result.status).toBe('ok');
  };
  const key = 'arr:childCare:n1:i6:c';
  const optionKey = `opt:${key}:opt-grandma`;
  await send('b', 'date-choose', { type: 'chooseOption', arrangementKey: key, optionKey,
    role: 'primary', assigneeId: 'a' });
  const first = await view('a');
  const task = first.plan.tasks.find((entry: { key: string }) => entry.key === `task:${optionKey}:ask`);
  const shown = task && proposalSnapshot(task);
  if (!task || !shown) throw Error('提案が無い');
  await send('a', 'date-accept', { type: 'accept', taskKey: task.key, shown });
  await page.getByRole('button', { name: '健太', exact: true }).click();
  await page.getByRole('button', { name: '送る', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: '送る文' })).toBeVisible();
  const draft = page.getByText(/12月7日/).first();
  await expect(draft).toBeVisible();

  // もう一人が原文の曜日と合う別の月曜日へ直した後、外から戻る。
  const change = { type: 'correctItem', itemId: 'n1:i6', interpretation: { date: '2026-12-14' } };
  const response = await request.post(`${api}/change-preview`, { data: { memberId: 'b', command: change } });
  const { preview } = await response.json();
  await send('b', 'date-correct', { ...change, seen: { throughSeq: preview.throughSeq, changes: preview.seen } });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByText('お願いの内容が変わりました。', { exact: false })).toBeVisible();
  await expect(page.getByText(/12月7日/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'コピー', exact: true })).toHaveCount(0);
  const recorded = page.waitForResponse((result) =>
    result.request().method() === 'POST' && result.url().endsWith('/commands') &&
    result.request().postDataJSON()?.command?.type === 'recordSent',
  );
  await page.getByRole('button', { name: '送ったことを記録' }).click();
  const result = await recorded;
  expect((await result.json()).result.status).toBe('ok');
  const command = result.request().postDataJSON().command;
  expect(command.window.start).toMatch(/^2026-12-07/);
  const after = await view('a');
  expect(after.plan.requests.find((entry: { requestId: string }) => entry.requestId === command.requestId))
    .toMatchObject({ live: true, needsCheck: true, window: command.window });
  expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
  expect(errors).toEqual([]);
});
