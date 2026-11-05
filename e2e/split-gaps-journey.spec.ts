import { expect, test } from '@playwright/test';
import { proposalSnapshot } from '../packages/core/src/index';

test('分かれた時間の画面と仮の計算を小さな画面で見る', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '用意した場面で見る（審査の方へ）' }).click();
  await page.getByRole('combobox', { name: '場面' }).selectOption('chase');
  await expect(page.getByText('デモの時計 11/29', { exact: false })).toBeVisible();
  const created = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/demo/sessions') &&
      r.request().method() === 'POST' &&
      r.request().postDataJSON()?.stage === 'arrived',
  );
  await page.getByRole('combobox', { name: '場面' }).selectOption('arrived');
  const { sessionId } = (await (await created).json()) as { sessionId: string };
  const api = `http://127.0.0.1:18797/api/demo/sessions/${sessionId}`;
  const getView = async () => (await request.get(`${api}/view?member=b`)).json();
  const original = await getView();
  const day = (memberId: string) => ({
    memberId,
    date: '2026-12-07',
    segments: [
      { start: '00:00', end: '09:00', kind: 'home', placeId: 'home' },
      { start: '09:00', end: '10:00', kind: 'work', placeId: 'home' },
      { start: '10:00', end: '15:00', kind: 'home', placeId: 'home' },
      { start: '15:00', end: '17:00', kind: 'work', placeId: 'home' },
      { start: '17:00', end: '23:59', kind: 'home', placeId: 'home' },
    ],
  });
  const household = {
    ...original.household,
    routineExceptions: [
      ...original.household.routineExceptions.filter(
        (d: { date: string; memberId: string }) =>
          d.date !== '2026-12-07' || !['a', 'b'].includes(d.memberId),
      ),
      day('a'),
      day('b'),
    ],
  };
  const previewResponse = await request.post(`${api}/household-preview`, {
    data: { memberId: 'b', household },
  });
  expect(previewResponse.status()).toBe(200);
  const { preview } = await previewResponse.json();
  const send = async (operationId: string, command: unknown) => {
    const response = await request.post(`${api}/commands`, {
      data: { memberId: 'b', operationId, command },
    });
    expect(response.status()).toBe(200);
  };
  await send('split-browser-household', {
    type: 'updateHousehold',
    household,
    seen: { throughSeq: preview.throughSeq, changes: preview.seen },
  });
  await page.getByRole('button', { name: '健太', exact: true }).click();
  await expect(
    page.getByText('見守れる大人を確かめられない時間が分かれています', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText('9:00–10:00', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('15:00–17:00', { exact: false }).first()).toBeVisible();
  const view = await getView();
  const care = view.plan.arrangements.find(
    (a: { kind: string; live: boolean }) => a.kind === 'childCare' && a.live,
  );
  const option = care.options.find((o: { templateId: string }) => o.templateId === 'opt-grandma');
  await send('split-browser-choose', {
    type: 'chooseOption',
    arrangementKey: care.key,
    optionKey: option.key,
    role: 'primary',
    assigneeId: 'b',
  });
  const chosen = await getView();
  const task = chosen.plan.tasks.find(
    (t: { basis: { optionKey?: string }; external?: unknown }) =>
      t.basis.optionKey === option.key && t.external,
  );
  const shown = proposalSnapshot(task);
  expect(shown).toBeDefined();
  await send('split-browser-accept', { type: 'accept', taskKey: task.key, shown });
  await send('split-browser-sent', {
    type: 'recordSent',
    taskKey: task.key,
    requestId: 'split-browser-ask',
    window: { start: care.start, end: care.end },
  });
  const saved = await getView();
  const recorded = saved.plan.requests.find(
    (r: { requestId: string }) => r.requestId === 'split-browser-ask',
  );
  expect(recorded).toMatchObject({ state: 'awaitingReply', sentBy: 'b', live: true });
  expect(recorded.needsCheck).not.toBe(true);
  expect(saved.today.quiet.map((row: { kind: string }) => row.kind)).toContain('waiting');
  const viewB = page.waitForResponse(
    (response) =>
      response.url().includes('/view?member=b') && response.request().method() === 'GET',
  );
  await page.getByRole('button', { name: '彩', exact: true }).click();
  const updated = await viewB;
  expect(updated.url().includes(sessionId)).toBe(true);
  await expect(
    page.getByText('見守れる大人を確かめられない時間が分かれています', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: '断られたら？' }).click();
  await expect(page.getByText('仮の計算', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('9:00–10:00', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('15:00–17:00', { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.getByText('This arrangement is for', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('only covers', { exact: false })).toHaveCount(0);
  expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
  expect(errors).toEqual([]);
});
