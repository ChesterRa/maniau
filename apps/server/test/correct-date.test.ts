// お知らせの日付を家族が直す時の、先に見た結果・古い画面・元の曜日の扱い。架空の通知だけを使う。
import {
  type Command,
  Extraction,
  notificationHistory,
  notificationIntents,
  type PreviewCommand,
  proposalSnapshot,
} from '@maniau/core';
import { computePlan, foldEvents, keys, liveItems } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { sendGate } from '../src/gate';
import { previewChange } from '../src/preview';
import { memoryStore } from '../src/store';
import { viewFor } from '../src/views';

const now = '2026-11-29T21:00+09:00';
const correct: PreviewCommand = {
  type: 'correctItem',
  itemId: 'n1:i6',
  interpretation: { date: '2026-12-14' },
};
function setup(
  misreadWeekday = false,
  withoutWeekday = false,
  stage: Parameters<typeof demoEvents>[0] = 'chase',
  missingLegacy?: 'snapshot' | 'window' | 'childId',
) {
  const initial = demoEvents(stage).map((e) => {
    if (missingLegacy && e.type === 'externalRequestSent' && e.requestId === 'r-grandma') {
      if (missingLegacy === 'snapshot') {
        const { snapshot: _, ...legacy } = e;
        return legacy;
      }
      if (e.snapshot) {
        const snapshot = { ...e.snapshot };
        delete snapshot[missingLegacy];
        return { ...e, snapshot };
      }
    }
    if (withoutWeekday && e.type === 'householdSet') {
      return {
        ...e,
        household: {
          ...e.household,
          routines: e.household.routines.map((routine) =>
            routine.memberId === 'a' && routine.weekday === 6
              ? {
                  ...routine,
                  segments: [
                    {
                      start: '07:00',
                      end: '21:00',
                      kind: 'home' as const,
                      placeId: 'home',
                      viaStationIds: [],
                    },
                  ],
                }
              : routine,
          ),
        },
      };
    }
    if (withoutWeekday && e.type === 'noticeReceived' && e.source.id === 'n1') {
      return {
        ...e,
        source: {
          ...e.source,
          sentences: e.source.sentences.map((s) =>
            s.id === 'n1#9' ? { ...s, text: '5日(土)に行った場合、12月7日は振替休業日です。' } : s,
          ),
        },
      };
    }
    if (
      withoutWeekday &&
      e.type === 'modelOutputRecorded' &&
      e.call === 'extract' &&
      e.sourceId === 'n1'
    ) {
      const output = Extraction.parse(e.output);
      output.items = output.items.map((item) => {
        if (item.id !== 'n1:i6') return item;
        const { writtenWeekday: _, ...interpretation } = item.interpretation;
        return {
          ...item,
          written: '5日(土)に行った場合、12月7日は振替休業日です。',
          interpretation,
        };
      });
      return { ...e, output };
    }
    if (!misreadWeekday) return e;
    if (e.type === 'noticeReceived' && e.source.id === 'n1')
      return {
        ...e,
        source: {
          ...e.source,
          sentences: e.source.sentences.map((s) =>
            s.id === 'n1#9'
              ? { ...s, text: '5日(土)に行った場合、12月8日(火)は振替休業日です。' }
              : s,
          ),
        },
      };
    if (e.type !== 'modelOutputRecorded' || e.call !== 'extract' || e.sourceId !== 'n1') return e;
    const output = Extraction.parse(e.output);
    output.items = output.items.map((i) =>
      i.id === 'n1:i6'
        ? {
            ...i,
            written: '5日(土)に行った場合、12月8日(火)は振替休業日です。',
            interpretation: { ...i.interpretation, writtenWeekday: 2 },
          }
        : i,
    );
    return { ...e, output };
  });
  const store = memoryStore(new Map([['demo', initial]]));
  let count = 0;
  const events = () => store.withHousehold('demo', (log) => [...log.events()]);
  const run = (memberId: string, command: Command) =>
    runCommand(
      store,
      'demo',
      { memberId, operationId: `correct-date-${++count}`, now, demo: true },
      command,
    );
  const look = async (memberId = 'a', command: PreviewCommand = correct) =>
    previewChange(await events(), { memberId, now }, command);
  const reread = async () =>
    store.withHousehold('demo', (log) => {
      const original = log
        .events()
        .find(
          (event) =>
            event.type === 'modelOutputRecorded' &&
            event.call === 'extract' &&
            event.sourceId === 'n1',
        );
      if (original?.type !== 'modelOutputRecorded') throw Error('読み取りが無い');
      const output = Extraction.parse(original.output);
      output.items = output.items.map((item) =>
        item.id === 'n1:i6'
          ? {
              ...item,
              interpretation: { ...item.interpretation, date: '2026-12-09', writtenWeekday: 3 },
            }
          : item,
      );
      log.append(
        [
          {
            type: 'modelOutputRecorded',
            call: 'extract',
            model: 'fixture',
            promptVersion: 'fixture',
            inputHash: 'reread',
            sourceId: 'n1',
            sourceVersion: 1,
            output,
          },
        ],
        'system',
        now,
      );
    });
  return { events, run, look, reread };
}
const issues = (events: Awaited<ReturnType<ReturnType<typeof setup>['events']>>) => {
  const set = events.findLast((e) => e.type === 'householdSet');
  if (set?.type !== 'householdSet') throw Error('家庭が無い');
  return verifyPlan({ household: set.household, plan: computePlan(events, now), events }).issues;
};

describe('日付を原文と照らして直す', () => {
  it('条件が古い日を直接比較していなくても、選択肢に残る日を確かめずに直さない', async () => {
    const initial = demoEvents('arrived').map((event) => {
      if (
        event.type !== 'modelOutputRecorded' ||
        event.call !== 'extract' ||
        event.sourceId !== 'n1'
      )
        return event;
      const output = Extraction.parse(event.output);
      // 比較式には 12/8 だけが現れるが、未定値の選択肢には 12/5 が残る。
      output.conditions = output.conditions.map((node) =>
        node.kind === 'eq' && node.value === '2026-12-05' ? { ...node, value: '2026-12-08' } : node,
      );
      return { ...event, output };
    });
    const item = viewFor(initial, 'a', now).items.find(
      (entry) => entry.item.kind === 'event' && entry.item.interpretation.date === '2026-12-05',
    );
    if (!item) throw Error('行事が無い');
    expect(foldEvents(initial).answers.some((answer) => answer.value === '2026-12-05')).toBe(false);
    expect(item.dateLinks).toContainEqual({ label: '学習発表会の実施日', value: '2026-12-05' });
    const command: PreviewCommand = {
      type: 'correctItem',
      itemId: item.item.id,
      interpretation: { date: '2026-12-12' },
    };
    expect(previewChange(initial, { memberId: 'a', now }, command)).toMatchObject({
      status: 'invalid',
      reason: 'dateLinkedCondition',
    });
    const store = memoryStore(new Map([['demo', initial]]));
    expect(
      await runCommand(
        store,
        'demo',
        { memberId: 'a', operationId: 'date-choice', now, demo: true },
        command,
      ),
    ).toMatchObject({ status: 'invalid', reason: 'dateLinkedCondition' });
  });

  it('行事の日付を直しても、元の日付を値に持つ条件を確かめたことにしない', async () => {
    const h = setup();
    const initial = await h.events();
    const reading = initial.find(
      (e) => e.type === 'modelOutputRecorded' && e.call === 'extract' && e.sourceId === 'n1',
    );
    if (reading?.type !== 'modelOutputRecorded') throw Error('読み取りが無い');
    const extraction = Extraction.parse(reading.output);
    const event = extraction.items.find(
      (i) => i.kind === 'event' && i.interpretation.date === '2026-12-05',
    );
    if (!event) throw Error('行事が無い');
    const shownItem = viewFor(initial, 'a', now).items.find((entry) => entry.item.id === event.id);
    expect(shownItem?.dateLinks).toContainEqual({
      label: '学習発表会の実施日',
      value: '2026-12-05',
    });
    const correction: PreviewCommand = {
      type: 'correctItem',
      itemId: event.id,
      interpretation: { date: '2026-12-12' },
    };
    const preview = await h.look('a', correction);
    expect(preview).toMatchObject({ status: 'invalid', reason: 'dateLinkedCondition' });
    expect(await h.events()).toEqual(initial);
    // 見る口を通さずに同じ命令を送っても受けない。
    expect(await h.run('a', correction)).toMatchObject({
      status: 'invalid',
      reason: 'dateLinkedCondition',
    });
    expect(await h.events()).toEqual(initial);
  });

  it('日付を直す前の答えが同じ値に入っていた時も、その答えと旧依頼を無条件で使い続けない', async () => {
    const h = setup();
    expect(
      await h.run('a', { type: 'answer', unknownId: 'n1:u1', value: '2026-12-05' }),
    ).toMatchObject({ status: 'ok' });
    const initial = await h.events();
    const reading = initial.find(
      (e) => e.type === 'modelOutputRecorded' && e.call === 'extract' && e.sourceId === 'n1',
    );
    if (reading?.type !== 'modelOutputRecorded') throw Error('読み取りが無い');
    const event = Extraction.parse(reading.output).items.find(
      (i) => i.kind === 'event' && i.interpretation.date === '2026-12-05',
    );
    if (!event) throw Error('行事が無い');
    const correction: PreviewCommand = {
      type: 'correctItem',
      itemId: event.id,
      interpretation: { date: '2026-12-12' },
    };
    const preview = await h.look('a', correction);
    expect(preview).toMatchObject({ status: 'invalid', reason: 'dateLinkedCondition' });
    expect(await h.events()).toEqual(initial);
    // 読み取りそのものが違うと家族が選べば、入れ間違えた通知とは区別して外し、既送依頼は確かめに残る。
    const discard: PreviewCommand = { type: 'discardSource', sourceId: 'n1', reason: 'misread' };
    const removal = await h.look('a', discard);
    if ('status' in removal) throw Error(removal.reason);
    expect(
      await h.run('a', {
        ...discard,
        seen: { throughSeq: removal.throughSeq, changes: removal.seen },
      }),
    ).toMatchObject({ status: 'ok' });
    const all = await h.events();
    expect(all.some((e) => e.type === 'sourceExcluded' && e.reason === 'misread')).toBe(true);
    const plan = computePlan(all, now);
    expect(plan.requests.find((r) => r.requestId === 'r-grandma')).toMatchObject({
      live: true,
      needsCheck: true,
    });
    expect(plan.tasks.some((t) => t.live && t.cancels === 'r-grandma')).toBe(false);
  });
  it('今は条件が合わない事項の日付を直しても、条件が合うまで計画には入れない', async () => {
    const h = setup();
    expect(
      await h.run('a', { type: 'answer', unknownId: 'n1:u1', value: '2026-12-08' }),
    ).toMatchObject({ status: 'ok' });
    expect(
      viewFor(await h.events(), 'a', now).items.find((entry) => entry.item.id === 'n1:i6')?.live,
    ).toBe(false);
    const correction: PreviewCommand = {
      type: 'correctItem',
      itemId: 'n1:i6',
      interpretation: { date: '2026-12-14' },
    };
    const preview = await h.look('a', correction);
    if ('status' in preview) throw Error('条件が合わない事項を見られない');
    expect(
      await h.run('a', {
        ...correction,
        seen: { throughSeq: preview.throughSeq, changes: preview.seen },
      }),
    ).toMatchObject({ status: 'ok' });
    expect(
      computePlan(await h.events(), now).arrangements.some(
        (arrangement) =>
          arrangement.live &&
          arrangement.kind === 'childCare' &&
          arrangement.key === 'arr:childCare:n1:i6:c',
      ),
    ).toBe(false);
    expect(
      await h.run('a', { type: 'answer', unknownId: 'n1:u1', value: '2026-12-05' }),
    ).toMatchObject({ status: 'ok' });
    const actual = computePlan(await h.events(), now);
    expect(
      actual.arrangements.find(
        (arrangement) => arrangement.kind === 'childCare' && arrangement.live,
      )?.start,
    ).toMatch(/^2026-12-14/);
    expect(issues(await h.events()).filter((issue) => issue.kind === 'violation')).toEqual([]);
  });
  it('変更を見てから保存し、既送の依頼は確認を残し、現実の取消しと決めない', async () => {
    const h = setup();
    const before = await h.events();
    const preview = await h.look();
    if ('status' in preview) throw Error(`${preview.status}/${preview.reason}`);
    expect(await h.events()).toEqual(before);
    expect(preview.changes.checks.map((r) => r.requestId)).toContain('r-grandma');
    expect(preview.changes.cancels.map((r) => r.requestId)).not.toContain('r-grandma');
    expect(
      await h.run('a', {
        ...correct,
        seen: { throughSeq: preview.throughSeq, changes: preview.seen },
      }),
    ).toMatchObject({ status: 'ok' });
    const after = await h.events(),
      p = computePlan(after, now);
    expect(p.requests.find((r) => r.requestId === 'r-grandma')).toMatchObject({
      live: true,
      needsCheck: true,
    });
    expect(p.arrangements.find((a) => a.kind === 'childCare' && a.live)?.start).toMatch(
      /^2026-12-14/,
    );
    expect(p.tasks.some((t) => t.cancels === 'r-grandma' && t.live)).toBe(false);
  });

  it('子の居場所が要らない日に直しても、既送の依頼は本人の確認を待つ', async () => {
    const h = setup(false, true);
    const saturday: PreviewCommand = { ...correct, interpretation: { date: '2026-12-12' } };
    const preview = await h.look('a', saturday);
    if ('status' in preview) throw Error(`${preview.status}/${preview.reason}`);
    expect(preview.changes.cancels.map((r) => r.requestId)).not.toContain('r-grandma');
    expect(
      await h.run('a', {
        ...saturday,
        seen: { throughSeq: preview.throughSeq, changes: preview.seen },
      }),
    ).toMatchObject({ status: 'ok' });
    const after = await h.events();
    const plan = computePlan(after, now);
    expect(plan.arrangements.some((a) => a.kind === 'childCare' && a.live)).toBe(false);
    expect(plan.requests.find((r) => r.requestId === 'r-grandma')).toMatchObject({
      live: true,
      needsCheck: true,
    });
    expect(plan.tasks.some((t) => t.live && t.cancels === 'r-grandma')).toBe(false);
    expect(issues(after).filter((issue) => issue.kind === 'violation')).toEqual([]);
    const household = after.findLast((event) => event.type === 'householdSet');
    if (household?.type !== 'householdSet') throw Error('家庭が無い');
    const forged = {
      ...plan,
      requests: plan.requests.map((r) =>
        r.requestId === 'r-grandma' ? { ...r, live: false, needsCheck: undefined } : r,
      ),
    };
    expect(
      verifyPlan({ household: household.household, plan: forged, events: after })
        .issues.filter((issue) => issue.kind === 'violation')
        .map((issue) => issue.code),
    ).toContain('corrected_date_request_unchecked');
    expect(
      await h.run('b', {
        type: 'resolveRequestCheck',
        requestId: 'r-grandma',
        decision: 'keep',
        seen: { throughSeq: plan.throughSeq },
      }),
    ).toMatchObject({ status: 'ok' });
    const kept = computePlan(await h.events(), now);
    expect(kept.requests.find((r) => r.requestId === 'r-grandma')).toMatchObject({
      live: true,
      standalone: true,
    });
    expect(issues(await h.events()).filter((issue) => issue.kind === 'violation')).toEqual([]);
    expect(
      await h.run('b', {
        type: 'resolveRequestCheck',
        requestId: 'r-grandma',
        decision: 'cancel',
        seen: { throughSeq: kept.throughSeq },
      }),
    ).toMatchObject({ status: 'ok' });
    const cancelled = computePlan(await h.events(), now);
    expect(cancelled.requests.find((r) => r.requestId === 'r-grandma')?.live).toBe(false);
    expect(cancelled.tasks.some((t) => t.live && t.cancels === 'r-grandma')).toBe(true);
    expect(issues(await h.events()).filter((issue) => issue.kind === 'violation')).toEqual([]);
  });

  it('日を直した後にお知らせが本当に取り下げられた場合、取消しを伝える', async () => {
    const h = setup(false, true);
    const saturday: PreviewCommand = { ...correct, interpretation: { date: '2026-12-12' } };
    const preview = await h.look('a', saturday);
    if ('status' in preview) throw Error(`${preview.status}/${preview.reason}`);
    expect(
      await h.run('a', {
        ...saturday,
        seen: { throughSeq: preview.throughSeq, changes: preview.seen },
      }),
    ).toMatchObject({ status: 'ok' });
    expect(await h.run('b', { type: 'withdrawSource', sourceId: 'n1' })).toMatchObject({
      status: 'ok',
    });
    const after = await h.events();
    const plan = computePlan(after, now);
    expect(plan.requests.find((r) => r.requestId === 'r-grandma')?.live).toBe(false);
    expect(plan.tasks.some((t) => t.live && t.cancels === 'r-grandma')).toBe(true);
    expect(issues(after).filter((issue) => issue.kind === 'violation')).toEqual([]);
  });

  it('条件が成り立たず既に不要になった依頼は、日付の直しだけで復活しない', async () => {
    const h = setup(false, true);
    expect(
      await h.run('a', { type: 'answer', unknownId: 'n1:u1', value: '2026-12-08' }),
    ).toMatchObject({ status: 'ok' });
    const before = computePlan(await h.events(), now);
    expect(before.requests.find((r) => r.requestId === 'r-grandma')?.live).toBe(false);
    const saturday: PreviewCommand = { ...correct, interpretation: { date: '2026-12-12' } };
    const preview = await h.look('a', saturday);
    if ('status' in preview) throw Error(`${preview.status}/${preview.reason}`);
    expect(
      await h.run('a', {
        ...saturday,
        seen: { throughSeq: preview.throughSeq, changes: preview.seen },
      }),
    ).toMatchObject({ status: 'ok' });
    const after = await h.events();
    const plan = computePlan(after, now);
    expect(plan.requests.find((r) => r.requestId === 'r-grandma')?.live).toBe(false);
    expect(plan.tasks.some((t) => t.live && t.cancels === 'r-grandma')).toBe(true);
    expect(issues(after).filter((issue) => issue.kind === 'violation')).toEqual([]);
  });

  it('家族が日を直す間に旧画面から送った時も、元の日の依頼を確かめに残す', async () => {
    const h = setup(false, true, 'arrived');
    const arrangementKey = 'arr:childCare:n1:i6:c';
    const optionKey = keys.option(arrangementKey, 'opt-grandma');
    expect(
      await h.run('b', {
        type: 'chooseOption',
        arrangementKey,
        optionKey,
        role: 'primary',
        assigneeId: 'a',
      }),
    ).toMatchObject({ status: 'ok' });
    let plan = computePlan(await h.events(), now);
    const task = plan.tasks.find((entry) => entry.key === `task:${optionKey}:ask`);
    const arrangement = plan.arrangements.find((entry) => entry.key === arrangementKey);
    const proposal = task && proposalSnapshot(task);
    if (!task || !arrangement || !proposal) throw Error('送る作業が無い');
    expect(await h.run('a', { type: 'accept', taskKey: task.key, shown: proposal })).toMatchObject({
      status: 'ok',
    });
    plan = computePlan(await h.events(), now);
    const sent: Command = {
      type: 'recordSent',
      taskKey: task.key,
      requestId: 'old-screen-date',
      window: { start: arrangement.start, end: arrangement.end },
      shown: { throughSeq: plan.throughSeq, at: now },
    };
    const saturday: PreviewCommand = { ...correct, interpretation: { date: '2026-12-12' } };
    const preview = await h.look('b', saturday);
    if ('status' in preview) throw Error(`${preview.status}/${preview.reason}`);
    expect(
      await h.run('b', {
        ...saturday,
        seen: { throughSeq: preview.throughSeq, changes: preview.seen },
      }),
    ).toMatchObject({ status: 'ok' });
    expect(await h.run('a', sent)).toMatchObject({ status: 'ok' });
    const after = await h.events();
    const actual = computePlan(after, now);
    expect(actual.requests.find((r) => r.requestId === 'old-screen-date')).toMatchObject({
      live: true,
      needsCheck: true,
      window: { start: arrangement.start, end: arrangement.end },
    });
    expect(actual.tasks.some((t) => t.live && t.cancels === 'old-screen-date')).toBe(false);
    expect(issues(after).filter((issue) => issue.kind === 'violation')).toEqual([]);
  });

  it('もう一人が先に直した後、古いプレビューでは上書きできない', async () => {
    const h = setup();
    const first = await h.look('a'),
      other = await h.look('b');
    if ('status' in first || 'status' in other) throw Error('見られない');
    expect(
      await h.run('b', { ...correct, seen: { throughSeq: other.throughSeq, changes: other.seen } }),
    ).toMatchObject({ status: 'ok' });
    expect(
      await h.run('a', { ...correct, seen: { throughSeq: first.throughSeq, changes: first.seen } }),
    ).toMatchObject({ status: 'conflict' });
    expect(await h.run('a', correct)).toMatchObject({ status: 'invalid', reason: 'seenRequired' });
  });

  it('原文の曜日に合う日付へ読解を直したら、古い読み違いを計画の違反として残さない', async () => {
    const h = setup(true);
    const prior = await h.events();
    expect(issues(prior).some((x) => x.code === 'weekday_mismatch' && x.subject === 'n1:i6')).toBe(
      true,
    );
    const right: PreviewCommand = { ...correct, interpretation: { date: '2026-12-08' } };
    const preview = await h.look('a', right);
    if ('status' in preview) throw Error(`${preview.status}/${preview.reason}`);
    expect(
      await h.run('a', {
        ...right,
        seen: { throughSeq: preview.throughSeq, changes: preview.seen },
      }),
    ).toMatchObject({ status: 'ok' });
    const after = await h.events();
    expect(issues(after).some((x) => x.code === 'weekday_mismatch' && x.subject === 'n1:i6')).toBe(
      false,
    );
    const source = after.find((e) => e.type === 'noticeReceived' && e.source.id === 'n1');
    expect(
      source?.type === 'noticeReceived' &&
        source.source.sentences.find((s) => s.id === 'n1#9')?.text,
    ).toContain('12月8日(火)');
  });

  it('原文から読んだ曜日と違う日付は、プレビューでも保存でも断り、記録を変えない', async () => {
    const h = setup(true);
    const before = await h.events();
    const wrong: PreviewCommand = { ...correct, interpretation: { date: '2026-12-09' } };
    const preview = await h.look('a', wrong);
    expect(preview).toMatchObject({ status: 'invalid', reason: 'dateWeekdayMismatch' });
    expect(
      await h.run('a', {
        ...wrong,
        seen: { throughSeq: before.at(-1)?.seq ?? 0, changes: 'not-saved' },
      }),
    ).toMatchObject({ status: 'invalid', reason: 'dateWeekdayMismatch' });
    expect(await h.events()).toEqual(before);
  });

  it('曜日と合わない直しで、正常だった家の知らせを一括で止めない', async () => {
    const h = setup();
    const before = await h.events();
    expect(issues(before).filter((issue) => issue.kind === 'violation')).toEqual([]);
    const gateAll = (events: typeof before) => {
      const set = events.findLast((event) => event.type === 'householdSet');
      if (set?.type !== 'householdSet') throw Error('家庭が無い');
      const plan = computePlan(events, now);
      const intents = notificationIntents(plan, set.household, notificationHistory(events));
      return sendGate({
        household: set.household,
        plan,
        events,
        intents,
        batchEnds: events.map((e) => e.seq),
      }).all;
    };
    expect(gateAll(before)).toBe(false);
    const wrong: PreviewCommand = { ...correct, interpretation: { date: '2026-12-08' } };
    expect(await h.look('a', wrong)).toMatchObject({
      status: 'invalid',
      reason: 'dateWeekdayMismatch',
    });
    expect(await h.events()).toEqual(before);
    expect(issues(await h.events()).filter((issue) => issue.kind === 'violation')).toEqual([]);
    expect(gateAll(await h.events())).toBe(false);
    const forged = memoryStore(new Map([['demo', before]]));
    const bad = await forged.withHousehold('demo', (log) => {
      log.append(
        [
          {
            type: 'itemCorrected',
            itemId: 'n1:i6',
            interpretation: { date: '2026-12-08' },
            readingBound: true,
          },
        ],
        'a',
        now,
      );
      return [...log.events()];
    });
    expect(gateAll(bad)).toBe(true);
  });

  it.each(['snapshot', 'window', 'childId'] as const)(
    '旧い依頼の %s が無い時は、旧い約束を勝手に取り消さないため日付の直しを断る',
    async (missing) => {
      const h = setup(false, true, 'chase', missing);
      const before = await h.events();
      const saturday: PreviewCommand = { ...correct, interpretation: { date: '2026-12-12' } };
      expect(await h.look('a', saturday)).toMatchObject({
        status: 'invalid',
        reason: 'legacyRequestUnclear',
      });
      expect(await h.run('a', saturday)).toMatchObject({
        status: 'invalid',
        reason: 'legacyRequestUnclear',
      });
      expect(await h.events()).toEqual(before);
    },
  );

  it('同じ ID で読み直された別の日に、前の直しと確かめを当てず、既送依頼を要確認にする', async () => {
    const h = setup();
    const preview = await h.look();
    if ('status' in preview) throw Error('見られない');
    expect(
      await h.run('a', {
        ...correct,
        seen: { throughSeq: preview.throughSeq, changes: preview.seen },
      }),
    ).toMatchObject({ status: 'ok' });
    const previouslyCorrected = computePlan(await h.events(), now);
    await h.reread();
    const after = await h.events();
    const item = liveItems(foldEvents(after)).find((entry) => entry.item.id === 'n1:i6');
    expect(item?.item.interpretation.date).toBe('2026-12-09');
    expect(item?.trusted).toBe(false);
    const p = computePlan(after, now);
    expect(p.arrangements.some((a) => a.kind === 'childCare' && a.live)).toBe(false);
    expect(p.requests.find((r) => r.requestId === 'r-grandma')).toMatchObject({
      live: true,
      needsCheck: true,
    });
    expect(p.tasks.some((t) => t.cancels === 'r-grandma' && t.live)).toBe(false);
    expect(issues(after).filter((issue) => issue.kind === 'violation')).toEqual([]);
    const oldRequirement = previouslyCorrected.requirements.find(
      (r) => r.live && r.basis.itemIds.includes('n1:i6'),
    );
    const set = after.findLast((event) => event.type === 'householdSet');
    if (!oldRequirement || set?.type !== 'householdSet') throw Error('要件または家庭が無い');
    const tampered = { ...p, requirements: [...p.requirements, oldRequirement] };
    expect(
      verifyPlan({ household: set.household, events: after, plan: tampered }).issues.map(
        (i) => i.code,
      ),
    ).toContain('correction_reread_unconfirmed');
    const confirmed: PreviewCommand = { ...correct, interpretation: { date: '2026-12-09' } };
    const again = await h.look('a', confirmed);
    if ('status' in again) throw Error('読み直しの後に見られない');
    expect(
      await h.run('a', {
        ...confirmed,
        seen: { throughSeq: again.throughSeq, changes: again.seen },
      }),
    ).toMatchObject({ status: 'ok' });
    const final = await h.events();
    expect(liveItems(foldEvents(final)).find((entry) => entry.item.id === 'n1:i6')?.trusted).toBe(
      true,
    );
  });
});
