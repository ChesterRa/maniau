import { expect, test } from '@playwright/test';

test('英語のデスクトップで、相手の答えを読み、家族が日を選ぶ', async ({ browser, request }) => {
  const ownerContext = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
    timezoneId: 'Asia/Tokyo',
  });
  const guestContext = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
    timezoneId: 'Asia/Tokyo',
  });
  try {
    const owner = await ownerContext.newPage();
    await owner.goto('http://127.0.0.1:15183/');
    await owner.getByRole('button', { name: '用意した場面で見る（審査の方へ）' }).click();
    await owner.getByRole('button', { name: 'English', exact: true }).click();
    await owner.getByRole('combobox', { name: 'Scene' }).selectOption('when');
    await owner.getByRole('button', { name: /collecting answers \(2 candidate days\)/ }).click();
    await expect(owner.getByText('Candidate days and answers', { exact: true })).toBeVisible();
    const guestRow = owner.getByText('近所のサトウさん: link is active', { exact: true }).locator('..');
    await guestRow.getByRole('button', { name: 'Make a new link' }).click();
    const url = await guestRow.locator('input[readonly]').inputValue();
    const guest = await guestContext.newPage();
    await guest.goto(url);
    await guest.getByRole('button', { name: 'English', exact: true }).click();
    await expect(guest.getByText('For 近所のサトウさん', { exact: true })).toBeVisible();
    await guest.getByRole('button', { name: '○ Yes', exact: true }).nth(1).click();
    await expect(guest.getByText('Your answer was sent.')).toBeVisible();
    await owner.getByRole('button', { name: 'Load the latest answers (from other screens or links)' }).click();
    const satoColumn = await owner.getByRole('columnheader', { name: '近所のサトウさん' })
      .evaluate((header) => (header as HTMLTableCellElement).cellIndex);
    const row = owner.locator('table tbody tr').nth(1);
    await expect(row.locator('td').nth(satoColumn - 1)).toHaveText('○');
    const countBox = await row.getByRole('cell', { name: '2/2', exact: true }).boundingBox();
    const scroll = owner.locator('table').locator('..');
    const tableBox = await scroll.boundingBox();
    if (!countBox || !tableBox) throw new Error('人数または表が見つかりません');
    expect(countBox.x).toBeGreaterThanOrEqual(tableBox.x);
    expect(countBox.x + countBox.width).toBeLessThanOrEqual(tableBox.x + tableBox.width + 1);
    const initial = await scroll.evaluate((el) => ({ width: el.clientWidth, contents: el.scrollWidth }));
    if (initial.contents > initial.width) {
      await expect(owner.getByText('Scroll the table sideways to see everyone’s answers.')).toBeVisible();
      await scroll.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
      expect(await scroll.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    }
    const card = owner.locator('section').filter({ has: owner.getByRole('heading', { name: /12\/13.*1:00 PM/ }) });
    await card.getByRole('button', { name: 'See what changes if you choose this day' }).click();
    await card.getByRole('button', { name: 'Choose this day', exact: true }).click();
    await expect(owner.getByText('Chosen day', { exact: true })).toBeVisible();
    expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
  } finally {
    await ownerContext.close();
    await guestContext.close();
  }
});
