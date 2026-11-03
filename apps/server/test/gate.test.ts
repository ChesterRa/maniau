// 送る文を作る側（core）と、検証器の許可表（verify）は、わざと別々に持つ。食い違うと、その種類の
// 知らせが全部止まる（安全側だが、気づきにくい）ので、全ての種類と言葉で突き合わせる。
import {
  NOTIFICATION_TEXT,
  type NotificationIntent,
  type NotificationLanguage,
  type NotificationTitle,
  notificationMessage,
} from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { messageGate } from '../src/gate';

const kinds: Record<NotificationTitle, NotificationIntent['kind']> = {
  'notify.released': 'assignment',
  'notify.releasedCheck': 'assignment',
  'notify.cancel': 'cancellation',
  'notify.check': 'question',
  'notify.backup': 'decisionApproaching',
  'notify.decide': 'decisionApproaching',
  'notify.proposal': 'assignment',
  'notify.changed': 'assignment',
  'notify.question': 'question',
  'notify.unowned': 'assignment',
  'notify.readCheck': 'question',
  'notify.need': 'decisionApproaching',
  'notify.needGaps': 'assignment',
};
const titles = Object.keys(kinds) as NotificationTitle[];

const intent = (titleKey: NotificationTitle, n: number): NotificationIntent => ({
  key: `${titleKey}:${n}:a`,
  subject: { type: 'task', id: `task-${n}` },
  toMemberId: 'a',
  kind: kinds[titleKey],
  titleKey,
});

describe('送る文と、検証器の許可表', () => {
  for (const language of Object.keys(NOTIFICATION_TEXT) as NotificationLanguage[]) {
    it(`${language}：一件ずつの文も、まとめた文も、全部通る`, () => {
      for (const [n, titleKey] of titles.entries()) {
        const intents = [intent(titleKey, n)];
        const message = notificationMessage(language, intents);
        expect(messageGate({ language, message, intents }), titleKey).toEqual({
          ok: true,
          codes: [],
        });
      }
      const all = titles.map((titleKey, n) => intent(titleKey, n));
      const message = notificationMessage(language, all);
      expect(messageGate({ language, message, intents: all })).toEqual({ ok: true, codes: [] });
    });
  }

  it('許可表に無い文（名前を足した等）は止める', () => {
    const intents = [intent('notify.decide', 0)];
    const message = {
      ...notificationMessage('ja', intents),
      body: '健太さん、決めることがあります。',
    };
    expect(messageGate({ language: 'ja', message, intents })).toEqual({
      ok: false,
      codes: ['notification_message_not_allowed'],
    });
  });
});
