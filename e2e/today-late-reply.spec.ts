// 日が過ぎてから返事を記録しても、存在しない次の札を出したとは言わない。
import { expect, test } from '@playwright/test';

for (const reply of ['yes', 'no'] as const) {
  test(`頼んだ時間の後の${reply === 'yes' ? 'OK' : '断り'}は、記録できた事だけを知らせる`, async ({ page, request }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '用意した場面で見る（審査の方へ）' }).click();
    const made = page.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/demo/sessions') &&
      response.request().postDataJSON()?.stage === 'chase',
    );
    await page.getByRole('combobox', { name: '場面' }).selectOption('chase');
    const { sessionId } = (await (await made).json()) as { sessionId: string };
    const api = `http://127.0.0.1:18797/api/demo/sessions/${sessionId}`;
    const clock = await request.post(`${api}/commands`, { data: {
      memberId: 'b', operationId: `late-clock-${reply}`,
      command: { type: 'advanceClock', to: '2026-12-07T19:00+09:00' },
    } });
    expect(clock.status()).toBe(200);
    expect((await clock.json()).result.status).toBe('ok');
    const view = async () => (await request.get(`${api}/view?member=b`)).json();
    const before = await view();
    expect(before.today.quiet.map((row: { kind: string }) => row.kind)).toContain('waiting');
    expect(before.plan.requests.find((row: { requestId: string }) => row.requestId === 'r-grandma'))
      .toMatchObject({ state: 'awaitingReply', live: true });

    await page.getByRole('button', { name: '健太', exact: true }).click();
    await page.getByRole('button', { name: '彩', exact: true }).click();
    await page.getByRole('button', { name: reply === 'yes' ? 'OK だった' : '断られた', exact: true }).click();
    await expect.poll(async () => (await view()).plan.requests.find(
      (row: { requestId: string }) => row.requestId === 'r-grandma',
    )?.state).toBe(reply === 'yes' ? 'confirmed' : 'turnedDown');
    const after = await view();
    expect(after.today.main).toEqual([]);
    const receipt = page.getByRole('status');
    await expect(receipt).toContainText(reply === 'yes' ? 'OK の返事を記録しました' : '断られたと記録しました');
    if (reply === 'yes') {
      await expect(page.getByRole('heading', { name: '決まったこと', exact: true })).toHaveCount(0);
      await expect(receipt).not.toContainText('「決まったこと」に入りました');
    } else {
      await expect(receipt).not.toContainText('次の手は「今やること」に出します');
    }
    expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
  });
}
