import { describe, expect, it } from 'vitest';
import { deadlineText } from '../src/household';
import { wayLines } from '../src/ways';
import { ctxFor } from './ctx';

describe('やり方の期限の言葉', () => {
  it.each([
    ['daysBefore', 1, 'By 21:00, 1 day before', '1日前の 21:00 まで'],
    ['daysBefore', 3, 'By 21:00, 3 days before', '3日前の 21:00 まで'],
    ['businessDaysBefore', 1, 'By 21:00, 1 business day before', '1営業日前の 21:00 まで'],
    ['businessDaysBefore', 3, 'By 21:00, 3 business days before', '3営業日前の 21:00 まで'],
  ] as const)('%s の %i 日を日英で表す', (type, days, en, ja) => {
    const rule = { type, days, at: '21:00' } as const;
    expect(deadlineText(ctxFor('arrived', 'b', 'en'), rule)).toBe(en);
    expect(deadlineText(ctxFor('arrived', 'b', 'ja'), rule)).toBe(ja);
  });

  it('手全体と手順の期限は、前置詞を重ねずに表示する', () => {
    const ctx = ctxFor('arrived', 'b', 'en');
    const grandma = ctx.household.ways.find((way) => way.id === 'way-grandma');
    const sickCare = ctx.household.ways.find((way) => way.id === 'way-sick-care');
    if (!grandma || !sickCare) throw new Error('見本のやり方が無い');
    expect(wayLines(ctx, grandma)).toContain('Decision time: By 21:00, 1 day before');
    expect(wayLines(ctx, sickCare)).toContain('病児保育を予約する: By 21:00, 1 day before');
  });
});
