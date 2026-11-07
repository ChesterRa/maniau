import { expect, test } from '@playwright/test';

test('候補のある用件を直す前に、答えとやり方が使えなくなると見せる', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '用意した場面で見る（審査の方へ）' }).click();
  const created = page.waitForResponse((r) => r.url().endsWith('/api/demo/sessions')
    && r.request().method() === 'POST' && r.request().postDataJSON()?.stage === 'club');
  await page.getByRole('combobox', { name: '場面' }).selectOption('club');
  const { sessionId } = await (await created).json() as { sessionId: string };
  const read = async () => (await request.get(`http://127.0.0.1:18797/api/demo/sessions/${sessionId}/view?member=b`)).json();
  const before = await read();
  const isClub = (r: { when?: { people: { id: string }[] } }) =>
    r.when?.people.some((person) => person.id === 'g-coach');
  const oldWhen = before.plan.requirements.find(isClub)?.when;
  expect(oldWhen.answers.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'クラブの練習：答えを集めています（候補 2 つ）' }).click();
  await page.getByRole('button', { name: '中身を直す' }).click();
  await expect(page.getByText(/日と時刻は「いつにするか」の候補が持つので、ここでは直せません/)).toBeVisible();
  await expect(page.getByText(/「候補の日を直す」で直せます/)).toBeVisible();
  await expect(page.locator('input[type=date], input[type=time]')).toHaveCount(0);
  const preview = page.getByRole('button', { name: 'この変更で変わることを見る' });
  await expect(preview).toBeDisabled();
  await page.getByLabel('何を（短く）').fill('クラブの練習と片付け');
  await expect(preview).toBeEnabled();
  await preview.click();
  await expect(page.getByText(`今の答え ${oldWhen.answers.length} 件は前の中身への物になり、数えなくなります`, { exact: false })).toBeVisible();
  await expect(page.getByText('選んだやり方を、もう一度選んでもらいます。')).toBeVisible();
  await expect(page.getByText('計画は変わりません。')).toHaveCount(0);
  await page.getByRole('button', { name: 'この内容で保存' }).click();
  await expect(page.getByRole('heading', { name: 'クラブの練習と片付け' })).toBeVisible();
  const after = await read();
  const newWhen = after.plan.requirements.find(isClub)?.when;
  expect(newWhen.answers).toEqual([]);
  for (const oldCandidate of oldWhen.candidates) {
    const newer = newWhen.candidates.find((c: { id: string }) => c.id === oldCandidate.id);
    expect(newer?.rev).toBeGreaterThan(oldCandidate.rev);
    expect([newer?.date, newer?.start, newer?.end]).toEqual([oldCandidate.date, oldCandidate.start, oldCandidate.end]);
  }
  expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
});

test('決めた後もまだ使っていなければ、直す前に決め直しを知らせる', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '用意した場面で見る（審査の方へ）' }).click();
  const created = page.waitForResponse((r) => r.url().endsWith('/api/demo/sessions')
    && r.request().method() === 'POST' && r.request().postDataJSON()?.stage === 'when');
  await page.getByRole('combobox', { name: '場面' }).selectOption('when');
  const { sessionId } = await (await created).json() as { sessionId: string };
  const read = async () => (await request.get(`http://127.0.0.1:18797/api/demo/sessions/${sessionId}/view?member=b`)).json();
  const isSitter = (r: { when?: { people: { id: string }[] } }) =>
    r.when?.people.some((person) => person.id === 'g-sato');
  await page.getByRole('button', { name: '陽菜を見てもらう：答えを集めています（候補 2 つ）' }).click();
  const card = page.locator('section').filter({ has: page.getByRole('heading', { name: /12\/13.*13:00/ }) });
  await card.getByRole('button', { name: 'この日に決めたら変わることを見る' }).click();
  await card.getByRole('button', { name: 'この日に決める', exact: true }).click();
  const before = await read();
  const oldWhen = before.plan.requirements.find(isSitter)?.when;
  expect(oldWhen.chosen).toBeTruthy();
  expect(oldWhen.inUse).toBe(false);
  await page.getByRole('button', { name: '中身を直す' }).click();
  await page.getByLabel('何を（短く）').fill('陽菜を午後に見てもらう');
  await page.getByRole('button', { name: 'この変更で変わることを見る' }).click();
  await expect(page.getByText(/決めた日を使わなくなります/)).toBeVisible();
  await page.getByRole('button', { name: 'この内容で保存' }).click();
  await expect(page.getByRole('heading', { name: '陽菜を午後に見てもらう' })).toBeVisible();
  const after = await read();
  const newWhen = after.plan.requirements.find(isSitter)?.when;
  expect(newWhen.chosen).toBeUndefined();
  expect(newWhen.answers).toEqual([]);
  expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
});

test('候補のある用件で、だれのためだけを外して保存できる', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '用意した場面で見る（審査の方へ）' }).click();
  await page.getByRole('combobox', { name: '場面' }).selectOption('club');
  await page.getByRole('button', { name: 'クラブの練習：答えを集めています（候補 2 つ）' }).click();
  await page.getByRole('button', { name: '中身を直す' }).click();
  const forMember = page.getByLabel('だれのため（任意）');
  await expect(forMember).not.toHaveValue('');
  await forMember.selectOption('');
  await page.getByRole('button', { name: 'この変更で変わることを見る' }).click();
  await expect(page.getByText(/今の答え 14 件は前の中身への物になり/)).toBeVisible();
  await page.getByRole('button', { name: 'この内容で保存' }).click();
  await page.getByRole('button', { name: '中身を直す' }).click();
  await expect(page.getByLabel('だれのため（任意）')).toHaveValue('');
});
