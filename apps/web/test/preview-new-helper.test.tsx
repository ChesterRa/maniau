// 「この変更で変わること」で、これから足す頼める人に頼む手を、その人の呼び名で言う。その人は直した後の家の情報に
// だけ居る（今の家の情報で名前を引くと空になり、「12/7（月）のに頼む」と出ていた）。
import { helperAskOption } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { householdPreviewLines } from '../src/household';
import { ctxFor } from './ctx';

const emptyChanges = {
  added: [],
  removed: [],
  moved: [],
  unplaced: [],
  placed: [],
  reassigned: [],
  changed: [],
  relocated: [],
  reconfirm: [],
  released: [],
  cancels: [],
  checks: [],
  deadlines: [],
  windows: [],
  conflicts: [],
  rechoose: [],
};

describe('これから足す頼める人の手', () => {
  for (const lang of ['ja', 'en'] as const) {
    it(`選べる手に入る・お勧めになる行に、直した後の家の情報の呼び名が入る（${lang}）`, () => {
      const ctx = ctxFor('arrived', 'a', lang);
      const arrangement = ctx.plan.arrangements.find((a) => a.kind === 'childCare');
      if (!arrangement) throw new Error('子の居場所の手配が無い');
      const after = structuredClone(ctx.household);
      after.members.push({ id: 'h-sato', kind: 'helper', name: 'サトウさん', active: true });
      after.careOptions.push(helperAskOption('opt-h-sato', 'h-sato', 3));
      const option = {
        arrangementKey: arrangement.key,
        optionKey: `${arrangement.key}:opt-h-sato`,
        templateId: 'opt-h-sato',
      };
      const preview = {
        changes: {
          ...emptyChanges,
          deadlines: [{ ...option, titleKey: 'option.askHelper', after: { expired: false } }],
          recommendations: [
            {
              arrangementKey: arrangement.key,
              kind: 'childCare' as const,
              ...(arrangement.childId ? { childId: arrangement.childId } : {}),
              after: { optionKey: option.optionKey, templateId: option.templateId },
            },
          ],
        },
        issues: [],
        unverified: [],
        seen: 'x',
        throughSeq: 1,
      };
      const lines = householdPreviewLines(ctx, preview as never, after);
      const title = ctx.t('option.askHelper.title', { name: 'サトウさん' });
      expect(lines.length).toBe(2);
      for (const line of lines) expect(line).toContain(title);
      // 今の家の情報には居ないので、呼び名が抜けた題（「に頼む」）にならない。
      const blank = ctx.t('option.askHelper.title', { name: '' });
      for (const line of lines) expect(line).not.toContain(`の${blank}`);
    });
  }
});
