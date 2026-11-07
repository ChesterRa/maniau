import { expect, test } from '@playwright/test';
import type { SessionView } from '../apps/web/src/family';
import { wayIdeasContext } from '../packages/core/src/reading/way-ideas';

// 架空の候補を HTTP で返す。読み取りの API は使わず、画面で確認してから W1 の正式な保存へ渡す道を確かめる。
test('未確認の案は表に写し、家族が選んで見てから保存する', async ({ page, request }) => {
  test.setTimeout(90_000);
  let viewUrl = '';
  let beforeSeq = 0;
  let calls = 0;
  await page.route('**/api/demo/sessions/*/way-ideas', async (route) => {
    calls += 1;
    const input = route.request().postDataJSON();
    const url = new URL(route.request().url());
    url.pathname = url.pathname.replace(/\/way-ideas$/, '/view');
    url.search = `?member=${encodeURIComponent(input.memberId)}`;
    viewUrl = url.toString();
    const response = await request.get(viewUrl);
    expect(response.ok()).toBeTruthy();
    const view = (await response.json()) as SessionView;
    beforeSeq = view.throughSeq;
    const sent = wayIdeasContext({ plan: view.plan, items: view.items.map((x) => x.item),
      household: view.household, sources: view.sources }, input.arrangementKey, input.text, input.language, input.memberId);
    expect(sent).toBeDefined();
    expect(sent?.familyWordsBy?.id).toBe(input.memberId);
    await route.fulfill({ status: 200, json: { sent, ideas: {
      drafts: [{ name: '祖母に見守りを聞く案', why: '聞いてみる案',
        steps: [{ name: '祖母に見守りを聞く', quote: null, assignee: { kind: 'unknown' },
          counterpart: { kind: 'helper', id: 'g' }, place: { kind: 'unknown' },
          minutes: null, segments: null, cover: null }],
        covers: 'unknown', cost: { leaveMinutes: null, helperRequests: 1, extraTasks: null }, unclear: [], notes: [] }],
      reuse: [], missing: [], notes: [],
    } } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '用意した場面で見る（審査の方へ）' }).click();
  await page.getByRole('combobox', { name: '場面' }).selectOption('arrived');
  await page.getByRole('button', { name: 'することを足す' }).click();
  await page.getByRole('button', { name: '時間を決めてだれかが要る時は、詳しく入れる' }).click();
  await page.getByLabel('言ったこと（そのまま）').fill('明日8時から18時まで見守りをお願いしたい。');
  await page.getByLabel('何を（短く）').fill('明日の見守り');
  await page.getByLabel('日', { exact: true }).fill('2026-11-26');
  await page.getByLabel('始まり', { exact: true }).fill('08:00');
  await page.getByLabel('終わり', { exact: true }).fill('18:00');
  await page.getByRole('button', { name: 'この変更で変わることを見る' }).click();
  await page.getByRole('button', { name: 'この内容で保存' }).click();
  const need = page.locator('section').filter({ hasText: '明日の見守り' })
    .filter({ has: page.getByRole('button', { name: '開く', exact: true }) });
  await need.getByRole('button', { name: '開く', exact: true }).click();
  await page.getByRole('button', { name: 'Claude に案を出してもらう' }).click();
  await page.getByLabel('家族の考え（任意）').fill('私は祖母に聞けるかもしれない。');
  await page.getByRole('button', { name: '案を出す（Claude が読みます）' }).click();
  await expect(page.getByText('祖母に見守りを聞く案')).toBeVisible();
  expect(calls).toBe(1);
  expect((await (await request.get(viewUrl)).json()).throughSeq).toBe(beforeSeq);
  await page.getByRole('button', { name: 'この案を表に入れる' }).click();
  const preview = page.getByRole('button', { name: 'この変更で変わることを見る' });
  await expect(preview).toBeDisabled();
  await expect(page.getByLabel('だれがする')).toHaveValue('?');
  await expect(page.getByLabel('返事までに見込む時間')).toHaveValue('');
  await expect(page.getByLabel('決まった場所')).toHaveValue('');
  await expect(page.getByLabel('かかる時間（分）')).toHaveValue('');
  await expect(page.getByLabel('家', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('いつまでに')).toHaveValue('');
  await expect(page.getByLabel('この手順をする人（外の相手なら相手）が、その時間を受け持つ')).toHaveValue('');
  await expect(page.getByLabel('費用（円）')).toBeDisabled();
  await page.getByLabel('だれがする').selectOption('b');
  await page.getByLabel('返事までに見込む時間').selectOption('60');
  await page.getByLabel('決まった場所').selectOption('-');
  await page.getByLabel('かかる時間（分）').fill('10');
  await page.getByLabel('家', { exact: true }).check();
  await page.getByLabel('いつまでに').selectOption('none');
  await page.getByLabel('この手順をする人（外の相手なら相手）が、その時間を受け持つ').selectOption('yes');
  await expect(page.getByLabel('受け持てる時間（分かっていれば）')).toHaveValue('');
  await page.getByLabel('受け持てる時間（分かっていれば）').selectOption('whole');
  await expect(preview).toBeEnabled();
  await preview.click();
  expect((await (await request.get(viewUrl)).json()).throughSeq).toBe(beforeSeq);
  await page.getByRole('button', { name: 'このやり方で保存' }).click();
  const after = await (await request.get(viewUrl)).json();
  const saved = after.household.ways.find((w: { name: string }) => w.name === '祖母に見守りを聞く案');
  expect(after.throughSeq).toBeGreaterThan(beforeSeq);
  expect(saved?.cost.unknown).toContain('yen');
  expect(saved?.steps[0].external.to).toBe('g');
  expect(after.plan.requests.length).toBe(0);
  expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
});
