// デモの知らせの候補（notify-preview.ts）：家族の家庭の送り手と同じ決まり（意図・夜の待ち・検証器の門・文の門）で
// 作り、送らない・記録しない。場面ごとに書き分けず、どの場面にも同じ決まりをかける。
import {
  type NotificationIntent,
  notificationHistory,
  notificationIntents,
  toEpochMinutes,
} from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { type DemoStageId, demoEvents } from '../src/demo';
import { demoSessions } from '../src/demo-sessions';
import type { MessageGate } from '../src/notifier';
import { notificationPreview, previewMembers } from '../src/notify-preview';

/** 大人ごとの「今送る」「朝に送る」「止めた数」。 */
const summary = (preview: Awaited<ReturnType<typeof viewAt>>['notificationPreview']) =>
  Object.fromEntries(
    (preview?.members ?? []).map((m) => [
      m.memberId,
      {
        now: m.now,
        ...(m.morning ? { morning: m.morning } : {}),
        blocked: m.blocked,
      },
    ]),
  );

async function viewAt(stage: DemoStageId, to?: string) {
  const sessions = demoSessions();
  const id = sessions.create(stage);
  if (to) {
    const moved = await sessions.command(id, 'a', `clock-${to}`, { type: 'advanceClock', to });
    expect(moved?.result.status).toBe('ok');
  }
  const view = await sessions.view(id, 'a');
  if (!view) throw new Error('見せる物が無い');
  return view;
}

describe('デモの場面のはじめの知らせの候補', () => {
  it('返事待ち（11/29 21:00）は彩にだけ予備の知らせ、延期は二人に取り消しの知らせ、ほかは無し', async () => {
    expect(summary((await viewAt('chase')).notificationPreview)).toEqual({
      a: { now: [], blocked: 0 },
      b: { now: ['notify.backup'], blocked: 0 },
    });
    expect(summary((await viewAt('postponed')).notificationPreview)).toEqual({
      a: { now: ['notify.cancel'], blocked: 0 },
      b: { now: ['notify.cancel'], blocked: 0 },
    });
    for (const stage of ['arrived', 'asked', 'backup'] as const) {
      const preview = (await viewAt(stage)).notificationPreview;
      expect(preview?.blockedAll).toBe(false);
      expect(summary(preview)).toEqual({ a: { now: [], blocked: 0 }, b: { now: [], blocked: 0 } });
    }
  });

  it('夜（22時から）は、朝 7 時まで待つ候補に分ける', async () => {
    const view = await viewAt('chase', '2026-11-29T23:00+09:00');
    expect(summary(view.notificationPreview)).toEqual({
      a: { now: [], blocked: 0 },
      b: {
        now: [],
        morning: { at: '2026-11-30T07:00+09:00', titles: ['notify.backup'] },
        blocked: 0,
      },
    });
  });

  it('送ってよい時（until）を過ぎた知らせは、候補に出さない', async () => {
    const start = await viewAt('chase');
    const backup = notificationIntents(start.plan, start.household, notificationHistory([])).find(
      (i) => i.toMemberId === 'b' && i.titleKey === 'notify.backup',
    );
    expect(backup?.until).toBeDefined();
    const after = await viewAt('chase', backup?.until);
    const b = after.notificationPreview?.members.find((m) => m.memberId === 'b');
    expect(b?.now).not.toContain('notify.backup');
    expect(b?.morning?.titles ?? []).not.toContain('notify.backup');
  });

  it('見せるだけで、事象を足さない（送った記録も残さない）', async () => {
    const sessions = demoSessions();
    const id = sessions.create('chase');
    const first = await sessions.view(id, 'b');
    const second = await sessions.view(id, 'b');
    expect(first?.notificationPreview?.members.find((m) => m.memberId === 'b')?.now).toEqual([
      'notify.backup',
    ]);
    expect(second?.throughSeq).toBe(first?.throughSeq);
    expect(second?.notificationPreview).toEqual(first?.notificationPreview);
  });
});

describe('検証器の門', () => {
  it('計画の違反で全部を止めた時は、送る候補を出さず、止めた数を出す（「無し」と見せない）', async () => {
    const view = await viewAt('chase');
    const events = loadDemoEvents('chase');
    const preview = notificationPreview(events, view.plan, view.household, {
      send: () => ({ all: true, blocked: new Set(), codes: ['test'] }),
    });
    expect(preview.blockedAll).toBe(true);
    expect(summary(preview)).toEqual({ a: { now: [], blocked: 0 }, b: { now: [], blocked: 1 } });
  });

  it('門が止めた知らせだけを外し、止めた数に入れる', async () => {
    const view = await viewAt('postponed');
    const events = loadDemoEvents('postponed');
    const intents = notificationIntents(view.plan, view.household, notificationHistory(events));
    const toA = intents.find((i) => i.toMemberId === 'a');
    if (!toA) throw new Error('健太への知らせが無い');
    const preview = notificationPreview(events, view.plan, view.household, {
      send: () => ({ all: false, blocked: new Set([toA.key]), codes: ['test'] }),
    });
    expect(preview.blockedAll).toBe(false);
    expect(summary(preview)).toEqual({
      a: { now: [], blocked: 1 },
      b: { now: ['notify.cancel'], blocked: 0 },
    });
  });

  it('文の門には、大人ごとにまとめた文をかけ（二つ以上は件数の文）、外れたらその大人の分を止める', () => {
    const intent = (key: string, titleKey: NotificationIntent['titleKey']): NotificationIntent => ({
      key,
      subject: { type: 'task', id: key },
      toMemberId: 'b',
      kind: 'assignment',
      titleKey,
    });
    const seen: { language: string; titleKey: string; count: number }[] = [];
    const refuse: MessageGate = ({ language, message, intents }) => {
      seen.push({ language, titleKey: message.titleKey, count: intents.length });
      return { ok: false, codes: ['test'] };
    };
    const members = previewMembers(
      [intent('t1', 'notify.cancel'), intent('t2', 'notify.backup')],
      { all: false, blocked: new Set() },
      ['a', 'b'],
      toEpochMinutes('2026-11-29T12:00+09:00'),
      'Asia/Tokyo',
      refuse,
    );
    expect(seen).toEqual([{ language: 'ja', titleKey: 'notify.many', count: 2 }]);
    expect(members).toEqual([
      { memberId: 'a', now: [], blocked: 0 },
      { memberId: 'b', now: [], blocked: 2 },
    ]);
    const pass: MessageGate = () => ({ ok: true, codes: [] });
    expect(
      previewMembers(
        [intent('t1', 'notify.cancel'), intent('t2', 'notify.backup')],
        { all: false, blocked: new Set() },
        ['b'],
        toEpochMinutes('2026-11-29T12:00+09:00'),
        'Asia/Tokyo',
        pass,
      ),
    ).toEqual([{ memberId: 'b', now: ['notify.cancel', 'notify.backup'], blocked: 0 }]);
  });
});

/** その場面のはじめの事象（デモの家庭と同じ物）。 */
const loadDemoEvents = (stage: DemoStageId) => demoEvents(stage);
