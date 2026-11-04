// その日だけの一日：一言の答えから前提の画面へ案内し、前提（だれ・日・変え方）を直せる欄で見せ、言われていない前提を
// 「仮に置いた前提」と分けて書く。作れない一日（行き来の時間が分からない等）は計算せずに訳を書く。「うち」には記録した
// 日の一覧と「この日だけ変える」を出す。
import type { MemberDayReply } from '@maniau/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HouseholdScreen } from '../src/household';
import {
  type MemberDayRoute,
  MemberDayScreen,
  memberDayRoute,
  SayMemberDay,
} from '../src/member-day';
import type { Ctx } from '../src/screens';
import { ctxFor } from './ctx';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const heard = (fields: Partial<MemberDayReply>): MemberDayReply => ({
  mode: 'hypothetical',
  change: 'off',
  memberId: 'b',
  date: '2026-12-07',
  problems: [],
  ...fields,
});
const screen = (route: Omit<MemberDayRoute, 'name'>, ctx: Ctx = ctxFor('chase', 'b', 'ja')) =>
  text(renderToStaticMarkup(<MemberDayScreen ctx={ctx} route={{ name: 'memberDay', ...route }} />));

describe('その日だけの一日', () => {
  it('一言の答え：読んだ前提と、仮の話で何も記録しないことを見せ、前提の画面へ案内する', () => {
    const ctx = ctxFor('chase', 'b', 'ja');
    const shown = text(
      renderToStaticMarkup(<SayMemberDay ctx={ctx} day={heard({})} onClear={() => {}} />),
    );
    expect(shown).toContain('仮の話として読みました。ここでは何も記録しません。');
    expect(shown).toContain('彩・12/7（月）・一日休み');
    expect(shown).toContain('この前提で計算する');
    expect(shown).not.toContain('記録する');
  });

  it('一言の答え：決められない欄は聞き、推し量らない', () => {
    const ctx = ctxFor('chase', 'b', 'ja');
    const shown = text(
      renderToStaticMarkup(
        <SayMemberDay
          ctx={ctx}
          day={heard({ change: 'away', problems: ['time'] })}
          onClear={() => {}}
        />,
      ),
    );
    expect(shown).toContain('時刻が分かりませんでした');
    expect(shown).toContain('前提を入れる');
  });

  it('前提の画面：欄と「仮に置いた前提」、ふだんとこの前提の一日を見せ、計算を待つ', () => {
    const shown = screen({
      memberId: 'b',
      date: '2026-12-07',
      change: 'off',
      said: 'hypothetical',
    });
    expect(shown).toContain('一言から読んだ前提（直せます）');
    expect(shown).toContain('仮に置いた前提');
    expect(shown).toContain('一日家にいて、子どもを見られるとして計算します');
    expect(shown).toContain('計算を見るだけでは、何も記録しません。');
    expect(shown).toContain('ふだん：06:30–08:00 家');
    expect(shown).toContain('この前提の一日：06:30–22:30 家');
    expect(shown).toContain('計算しています');
    expect(shown).toContain('この日を記録する');
  });

  it('前提の画面：仕事の途中で家に移る一日は、計算せずに訳と代わりの選び方を書く', () => {
    const shown = screen({
      memberId: 'b',
      date: '2026-12-07',
      change: 'home',
      from: '09:00',
      to: '17:00',
      said: 'hypothetical',
    });
    expect(shown).toContain('行き来の時間が分からないため、計算しません');
    expect(shown).not.toContain('この日を記録する');
  });

  it('前提の画面：だれ・日が決まらない時は聞き、計算しない', () => {
    const shown = screen({ change: 'off', said: 'undetermined' });
    expect(shown).toContain('だれの一日か分かりませんでした');
    expect(shown).toContain('仮の話として計算します');
    expect(shown).not.toContain('この日を記録する');
  });

  it('一言で決められなかった欄は、前提の画面に持って行き、直すまで計算しない', () => {
    // 日と曜日が食い違う：読んだ日を入れずに聞く。
    const weekday = memberDayRoute(heard({ problems: ['weekday'] }));
    expect(weekday.date).toBeUndefined();
    expect(weekday.asks).toEqual(['weekday']);
    const shownWeekday = screen({ ...weekday });
    expect(shownWeekday).toContain('日と曜日が合いません');
    expect(shownWeekday).not.toContain('この日を記録する');
    // 過ぎた日：読んだ日を入れず、画面でも過ぎた日は計算しない。
    expect(memberDayRoute(heard({ problems: ['date'] })).date).toBeUndefined();
    const past = screen({ memberId: 'b', date: '2026-11-20', change: 'off', said: 'hypothetical' });
    expect(past).toContain('過ぎた日は計算しません');
    expect(past).not.toContain('この日を記録する');
    // 一日休みに時刻が付いていた：一日休みに決めず、時刻は残して選んでもらう。
    const timed = memberDayRoute(
      heard({ change: 'off', from: '09:00', to: '17:00', problems: ['time'] }),
    );
    expect(timed.change).toBeUndefined();
    expect(timed).toMatchObject({ from: '09:00', to: '17:00', asks: ['offWithTime'] });
    const shownTimed = screen({ ...timed });
    expect(shownTimed).toContain('「一日休み」か「その時間は家」を選んでください');
    expect(shownTimed).not.toContain('この前提の一日');
    expect(shownTimed).not.toContain('この日を記録する');
  });

  it('一言から来た時は、家族の原文を読んだ前提と並べて見せる（日英。見るだけでは記録しない）', () => {
    const route = memberDayRoute(heard({ date: '2026-11-30' }), '明日、彩が休んだら？');
    expect(route.text).toBe('明日、彩が休んだら？');
    const shown = screen({ ...route });
    expect(shown).toContain('一言：「明日、彩が休んだら？」');
    expect(shown).toContain('計算を見るだけでは、何も記録しません。');
    const english = screen(
      { ...memberDayRoute(heard({ date: '2026-11-30' }), 'What if Aya is off tomorrow?') },
      ctxFor('chase', 'b', 'en'),
    );
    expect(english).toContain('You said: “What if Aya is off tomorrow?”');
    // 「うち」から来た時は、原文が無いので出さない。
    expect(screen({ memberId: 'b', date: '2026-12-07', change: 'off' })).not.toContain('一言：');
  });

  it('英語でも同じ前提を出す', () => {
    const shown = screen(
      { memberId: 'b', date: '2026-12-07', change: 'off', said: 'hypothetical' },
      ctxFor('chase', 'b', 'en'),
    );
    expect(shown).toContain('Assumptions we added');
    expect(shown).toContain('With these details: 06:30–22:30 Home');
    expect(shown).toContain('Record this day');
  });

  it('「うち」：記録したその日だけの一日の一覧と「この日だけ変える」を出す', () => {
    const base = ctxFor('chase', 'b', 'ja');
    const ctx: Ctx = {
      ...base,
      household: {
        ...base.household,
        routineExceptions: [
          {
            memberId: 'b',
            date: '2026-12-07',
            segments: [
              { start: '06:30', end: '22:30', kind: 'home', placeId: 'home', viaStationIds: [] },
            ],
          },
        ],
      },
    };
    const shown = text(renderToStaticMarkup(<HouseholdScreen ctx={ctx} />));
    expect(shown).toContain('その日だけの一日');
    expect(shown).toContain('12/7（月） 彩：06:30–22:30 家');
    expect(shown).toContain('この日だけ変える');
  });
});
