// お知らせの事項の時刻・名前を家族が直す時と、一件だけ計画から外す時（11/7 体検：元の文の画面に口が無かった）。
// 画面と同じ道（先に見る → 見た物を添えて記録する → 見せる物）で、計画が組み直り、検証器を通ることを確かめる。
// 架空の通知だけを使う。
import type { PreviewCommand, SaveablePreview } from '@maniau/core';
import { computePlan, foldEvents } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { previewChange } from '../src/preview';
import { memoryStore } from '../src/store';
import { viewFor } from '../src/views';

function setup(
  stage: Parameters<typeof demoEvents>[0],
  now: string,
  edit: (events: ReturnType<typeof demoEvents>) => ReturnType<typeof demoEvents> = (e) => e,
) {
  const store = memoryStore(new Map([['demo', edit(demoEvents(stage))]]));
  let count = 0;
  const events = () => store.withHousehold('demo', (log) => [...log.events()]);
  const run = (command: Parameters<typeof runCommand>[3]) =>
    runCommand(
      store,
      'demo',
      { memberId: 'b', operationId: `correct-time-${++count}`, now, demo: true },
      command,
    );
  const look = async (command: PreviewCommand) =>
    previewChange(await events(), { memberId: 'b', now }, command);
  /** 画面と同じ：見てから、見た物を添えて書く。 */
  const save = async (command: SaveablePreview) => {
    const shown = await look(command);
    if ('reason' in shown) throw new Error(`見られない：${shown.reason}`);
    return {
      shown,
      result: await run({
        ...command,
        seen: { throughSeq: shown.throughSeq, changes: shown.seen },
      }),
    };
  };
  const view = async () => viewFor(await events(), 'b', now);
  // 検証器は求解と別に、記録から組み直した計画を確かめる（破った決まりだけを見る）。
  const violations = async () => {
    const all = await events();
    const household = foldEvents(all).household;
    if (!household) throw new Error('家の情報が無い');
    return verifyPlan({ household, plan: computePlan(all, now), events: all }).issues.filter(
      (issue) => issue.kind === 'violation',
    );
  };
  return { run, look, save, view, violations };
}

describe('事項の時刻・名前の直しと、一件だけ外す', () => {
  it('時刻と名前を直す：見てから記録すると、見せる物の時刻と名前が替わり、日は替わらず、計画は検証器を通る', async () => {
    const h = setup('arrived', '2026-11-25T19:31+09:00');
    const item = (await h.view()).items.find(
      ({ item }) => item.kind === 'event' && item.interpretation.startTime !== undefined,
    )?.item;
    if (!item) throw new Error('時刻のある行事が無い');
    const { result } = await h.save({
      type: 'correctItem',
      itemId: item.id,
      interpretation: { startTime: '10:30', what: '1年生の発表（直した）' },
    });
    expect(result.status).toBe('ok');
    const corrected = (await h.view()).items.find((entry) => entry.item.id === item.id)?.item;
    expect(corrected?.interpretation.startTime).toBe('10:30');
    expect(corrected?.interpretation.what).toBe('1年生の発表（直した）');
    expect(corrected?.interpretation.date).toBe(item.interpretation.date);
    expect(await h.violations()).toEqual([]);
  });

  it('日付の無い持ち物の名前も直せる：見てから記録すると、持ち物の要件の名前が替わり、検証器を通る', async () => {
    const h = setup('arrived', '2026-11-25T19:31+09:00');
    const shirt = (await h.view()).items.find(({ item }) => item.kind === 'belongings')?.item;
    if (!shirt) throw new Error('持ち物が無い');
    const { result } = await h.save({
      type: 'correctItem',
      itemId: shirt.id,
      interpretation: { what: '白い半袖シャツ' },
    });
    expect(result.status).toBe('ok');
    const after = await h.view();
    expect(after.plan.requirements.find((r) => r.kind === 'belongings' && r.live)?.what).toBe(
      '白い半袖シャツ',
    );
    expect(await h.violations()).toEqual([]);
  });

  it('始まりを読み落としたかもしれない行事に家族が始まりを入れると、読み取りの印が外れる（確かめを求め続けない）', async () => {
    // 延期の後の 12/8 の発表（n1:i4）を、始まりの時刻を読み落とした読み取りにする。
    const unsure = (events: ReturnType<typeof demoEvents>) =>
      events.map((event) => {
        if (event.type !== 'modelOutputRecorded' || event.call !== 'extract') return event;
        const output = event.output as { items?: { id: string; interpretation: object }[] };
        if (!output.items?.some((item) => item.id === 'n1:i4')) return event;
        return {
          ...event,
          output: {
            ...output,
            items: output.items.map((item) => {
              if (item.id !== 'n1:i4') return item;
              const { startTime: _, ...rest } = item.interpretation as { startTime?: string };
              return { ...item, interpretation: { ...rest, startTimeUnconfirmed: true } };
            }),
          },
        } as typeof event;
      });
    const h = setup('postponed', '2026-12-04T18:10+09:00', unsure);
    const before = (await h.view()).items.find((entry) => entry.item.id === 'n1:i4')?.item;
    expect(before?.interpretation).toMatchObject({ startTimeUnconfirmed: true });
    expect(before?.interpretation.startTime).toBeUndefined();
    const { result } = await h.save({
      type: 'correctItem',
      itemId: 'n1:i4',
      interpretation: { startTime: '09:20' },
    });
    expect(result.status).toBe('ok');
    const after = (await h.view()).items.find((entry) => entry.item.id === 'n1:i4')?.item;
    expect(after?.interpretation.startTime).toBe('09:20');
    expect(after?.interpretation.startTimeUnconfirmed).toBeUndefined();
    expect(await h.violations()).toEqual([]);
  });

  it('まだ確かめていない事項は、名前・時刻だけの直しでは確かにせず断る。日付を確かめた後は直せる', async () => {
    // 延期の後の 12/8 の発表（n1:i4）を、書かれた日を入れずに入れた「あした」の読み取り（届いた日から数えた推定）にする。
    const unanchored = (events: ReturnType<typeof demoEvents>) =>
      events.map((event) => {
        if (event.type !== 'modelOutputRecorded' || event.call !== 'extract') return event;
        const output = event.output as {
          items?: { id: string; evidence: string; interpretation: object }[];
        };
        if (!output.items?.some((item) => item.id === 'n1:i4')) return event;
        return {
          ...event,
          output: {
            ...output,
            items: output.items.map((item) =>
              item.id !== 'n1:i4'
                ? item
                : {
                    ...item,
                    evidence: 'inferred',
                    interpretation: {
                      ...item.interpretation,
                      relativeDay: 'tomorrow',
                      relativeDayFromReceived: '2026-12-07',
                    },
                  },
            ),
          },
        } as typeof event;
      });
    const h = setup('postponed', '2026-12-04T18:10+09:00', unanchored);
    const before = (await h.view()).items.find((entry) => entry.item.id === 'n1:i4');
    expect(before?.trusted).toBe(false);
    const date = before?.item.interpretation.date;
    if (!date) throw new Error('日付が無い');
    // 名前だけの直し：見る所でも、記録でも断る（確かめていない日付を、確かにしない）。
    const rename = {
      type: 'correctItem' as const,
      itemId: 'n1:i4',
      interpretation: { what: '1年生の発表（直した）' },
    };
    expect(await h.look(rename)).toMatchObject({ reason: 'itemUnconfirmed' });
    expect(await h.run(rename)).toMatchObject({ status: 'invalid', reason: 'itemUnconfirmed' });
    expect((await h.view()).items.find((entry) => entry.item.id === 'n1:i4')?.trusted).toBe(false);
    // 同じ日のままで日付を確かめると確かになり、その後は名前を直せる。
    expect((await h.save({ ...rename, interpretation: { date } })).result.status).toBe('ok');
    expect((await h.view()).items.find((entry) => entry.item.id === 'n1:i4')?.trusted).toBe(true);
    expect((await h.save(rename)).result.status).toBe('ok');
    expect(await h.violations()).toEqual([]);
  });

  it('一件だけ外す：頼んだ後に振替休業日を外すと、外す前に取り消しの連絡が要ると見え、外すと依頼は要らなくなる', async () => {
    // 祖母に 12/7 を頼んで返事を待つ段。12/7 の振替休業日（n1:i6）だけを「うちに関係ない」と外す。
    const h = setup('chase', '2026-11-29T21:00+09:00');
    const before = await h.view();
    const holiday = before.items.find((entry) => entry.item.id === 'n1:i6');
    expect(holiday?.live).toBe(true);
    const asked = before.plan.requests.find((r) => r.live && r.state === 'awaitingReply');
    if (!asked) throw new Error('返事待ちの依頼が無い');
    const { shown, result } = await h.save({
      type: 'dismissItem',
      itemId: 'n1:i6',
      reason: 'notOurs',
    });
    // 外す前に見せる物に、送った依頼の取り消しが出る（黙って要らなくしない）。
    expect(shown.changes.cancels.length).toBeGreaterThan(0);
    expect(result.status).toBe('ok');
    const after = await h.view();
    // 外した一件は、今の事項（見せる物）に来ない。
    expect(after.items.some((entry) => entry.item.id === 'n1:i6')).toBe(false);
    // ほかの事項（発表会など）は残る。
    expect(after.items.filter((entry) => entry.live).length).toBe(
      before.items.filter((entry) => entry.live).length - 1,
    );
    expect(after.plan.requests.find((r) => r.requestId === asked.requestId)?.live).toBe(false);
    expect(after.plan.tasks.some((t) => t.live && t.cancels === asked.requestId)).toBe(true);
    expect(await h.violations()).toEqual([]);
  });
});
