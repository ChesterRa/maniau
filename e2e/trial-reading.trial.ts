// 入力欄から試験用読み取りへ、別々の二つの架空文を通す。実 API は呼ばない。
import { expect, test } from '@playwright/test';

test('携帯幅の欄から二つの架空文を送り、原文と日付が入れ替わらない', async ({ page, request }) => {
  const before = (await (await request.get('http://127.0.0.1:18797/__e2e/reads')).json()).length;
  await page.goto('/');
  await page.getByRole('button', { name: 'はじめる', exact: true }).click();
  await page.getByLabel('あなたの呼び名').fill('大人A');
  await page.getByLabel('子どもの呼び名').fill('子H');
  await page.getByRole('button', { name: 'この家族で始める' }).click();
  await expect(page.getByText('まだお知らせがありません')).toBeVisible();
  const texts = ['2026年12月7日（月）は休校です。', '2026年12月14日（月）は休校です。'];
  const dates = ['2026-12-07', '2026-12-14'];
  const ids: string[] = [];
  let sessionId: string | undefined;
  for (const [index, text] of texts.entries()) {
    await page.getByRole('button', { name: index === 0 ? 'お知らせを入れる' : 'お知らせ', exact: true }).click();
    await expect(page.getByText('架空の文だけを使ってください', { exact: false })).toBeVisible();
    await page.getByRole('textbox', { name: 'お知らせを入れる' }).fill(text);
    const response = page.waitForResponse((r) =>
      r.request().method() === 'POST' && r.url().endsWith('/notices'),
    );
    await page.getByRole('button', { name: '読み取る', exact: true }).click();
    const posted = await response;
    expect(posted.status()).toBe(200);
    const postedSession = /\/api\/demo\/sessions\/([^/]+)\/notices$/.exec(posted.url())?.[1];
    expect(postedSession).toBeTruthy();
    if (sessionId) expect(postedSession).toBe(sessionId);
    sessionId = postedSession;
    ids.push((await posted.json()).sourceId);
    await expect(page.getByText(text, { exact: false }).first()).toBeVisible();
  }
  expect(ids[0]).not.toBe(ids[1]);
  const view = await (await request.get(`http://127.0.0.1:18797/api/demo/sessions/${sessionId}/view?member=a1`)).json();
  for (const [index, id] of ids.entries()) {
    expect(view.sources.find((source: {id: string}) => source.id === id).sentences[0].text).toBe(texts[index]);
    expect(view.items.find((entry: {item: {sourceId: string}}) => entry.item.sourceId === id).item.interpretation.date).toBe(dates[index]);
  }
  expect((await (await request.get('http://127.0.0.1:18797/__e2e/reads')).json()).slice(before).map((call: {text:string}) => call.text)).toEqual(texts);
  expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
  await page.reload();
  await expect.poll(async () => page.evaluate(() => localStorage.getItem('maniau.trial.v1'))).toBe(sessionId);
  await expect(page.getByText('子H', { exact: false }).first()).toBeVisible();
});
