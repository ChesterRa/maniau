// 一言の原文の日の言い方から、コードが独立に求める日（モデルの読んだ日を確かめるため）。一つに決まらない言い方は、
// 当てはまる日を全部返す（呼ぶ側は聞く）。読まない言い方は空にする。
import { describe, expect, it } from 'vitest';
import { datesSaid } from '../src/reading/said-date';

const sunday = '2026-11-29';
const wednesday = '2026-12-02';
const dates = (text: string, today = sunday) => [...datesSaid(text, today).dates].sort();

describe('原文の日の言い方', () => {
  it('今日・明日・明後日（日本語と英語）', () => {
    expect(dates('今日、彩が休んだら？')).toEqual(['2026-11-29']);
    expect(dates('明日、彩が休んだら？')).toEqual(['2026-11-30']);
    expect(dates('あした休めたら')).toEqual(['2026-11-30']);
    expect(dates('明後日は家にいられる')).toEqual(['2026-12-01']);
    expect(dates('あさって在宅なら')).toEqual(['2026-12-01']);
    expect(dates('今夜遅くなったら')).toEqual(['2026-11-29']);
    expect(dates('What if I stay home today?')).toEqual(['2026-11-29']);
    expect(dates('What if Aya takes tomorrow off?')).toEqual(['2026-11-30']);
    // 「the day after tomorrow」を明日と二度読みしない。
    expect(dates('What if I am off the day after tomorrow?')).toEqual(['2026-12-01']);
  });

  it('月日は、去年・今年・来年のうち今日に一番近い日（全角も読む）', () => {
    expect(dates('12/7 に私が休めたら？')).toEqual(['2026-12-07']);
    expect(dates('１２月７日に休んだら')).toEqual(['2026-12-07']);
    expect(dates('1/5 に休んだら')).toEqual(['2027-01-05']);
    expect(dates('11/28 に休んでいたら')).toEqual(['2026-11-28']);
    expect(dates('2027年1月5日に休んだら')).toEqual(['2027-01-05']);
    expect(dates('What if I take December 7 off?')).toEqual(['2026-12-07']);
    expect(dates('What if I am off on 7th Dec?')).toEqual(['2026-12-07']);
    // 無い日は日にしない。
    expect(dates('2/30 に休んだら')).toEqual([]);
    // 月日の後の時刻は年にしない。
    expect(dates('Dec 7 at 10:00')).toEqual(['2026-12-07']);
    expect(dates('12/7 17:30まで会議')).toEqual(['2026-12-07']);
  });

  it('年を書いた月日はその年で読み、読めない年・年の言葉がある時は年を落とさずに読まない', () => {
    expect(dates('What if I take December 7, 2027 off?')).toEqual(['2027-12-07']);
    expect(dates('Dec 7th 2027')).toEqual(['2027-12-07']);
    expect(dates('7 December 2027')).toEqual(['2027-12-07']);
    expect(dates('12/7, 2027')).toEqual(['2027-12-07']);
    expect(dates('2027/12/7 に休んだら')).toEqual(['2027-12-07']);
    expect(dates("Dec 7 '27")).toEqual([]);
    expect(dates('令和9年12月7日に休んだら')).toEqual([]);
    expect(dates('来年の12月7日に休んだら')).toEqual([]);
    expect(dates('What if I am off on December 7 next year?')).toEqual([]);
  });

  it('日に添えた曜日は、日を指す言い方にせず、添えた曜日として返す', () => {
    expect(datesSaid('12/7（月）に休んだら', sunday)).toEqual({
      dates: ['2026-12-07'],
      weekdays: [1],
    });
    expect(datesSaid('明日 月曜日は家にいられる', sunday)).toEqual({
      dates: ['2026-11-30'],
      weekdays: [1],
    });
    expect(datesSaid('Monday, December 7', sunday)).toEqual({
      dates: ['2026-12-07'],
      weekdays: [1],
    });
  });

  it('曜日だけの言い方：週の始まり（月曜か日曜か）や「next」の取り方で変わる時は、全部を返す', () => {
    // 水曜から見て。
    expect(dates('金曜に休んだら', wednesday)).toEqual(['2026-12-04']);
    expect(dates('今週の金曜に休んだら', wednesday)).toEqual(['2026-12-04']);
    expect(dates('来週の月曜に休んだら', wednesday)).toEqual(['2026-12-07']);
    expect(dates('来週は月曜に休む', wednesday)).toEqual(['2026-12-07']);
    expect(dates('再来週の水曜', wednesday)).toEqual(['2026-12-16']);
    expect(dates('来週の日曜', wednesday)).toEqual(['2026-12-06', '2026-12-13']);
    expect(dates('this Friday', wednesday)).toEqual(['2026-12-04']);
    expect(dates('on Friday', wednesday)).toEqual(['2026-12-04']);
    expect(dates('Friday next week', wednesday)).toEqual(['2026-12-11']);
    expect(dates('next Monday', wednesday)).toEqual(['2026-12-07']);
    expect(dates('next Friday', wednesday)).toEqual(['2026-12-04', '2026-12-11']);
    // 日曜（11/29）から見た「来週の月曜」「next Monday」は、11/30 とも 12/7 とも取れる。
    expect(dates('来週の月曜に休んだら？')).toEqual(['2026-11-30', '2026-12-07']);
    expect(dates('next Monday')).toEqual(['2026-11-30', '2026-12-07']);
    // 今日がその曜日なら、今日か来週か決められない。
    expect(dates('日曜に休んだら')).toEqual(['2026-11-29', '2026-12-06']);
  });

  it('日の言い方を含む家の人の名前は日として読まず、ほかの所の日は読む', () => {
    expect(datesSaid('明日香が休んだら？', sunday, ['明日香', '彩']).dates).toEqual([]);
    expect(datesSaid('明日香が明日休んだら？', sunday, ['明日香', '彩']).dates).toEqual([
      '2026-11-30',
    ]);
    // 日の言い方を含まない名前（「明」）は消さない（「明日」を壊さない）。
    expect(datesSaid('明日、明が休んだら？', sunday, ['明']).dates).toEqual(['2026-11-30']);
    // 互いに含む名前は長い方から消し、名前の記号は文字のとおりに扱う（正規表現にしない）。
    expect(datesSaid('明日香子が明日休んだら？', sunday, ['明日香', '明日香子']).dates).toEqual([
      '2026-11-30',
    ]);
    expect(datesSaid('明日(仮)さんが 12/7 に休んだら？', sunday, ['明日(仮)']).dates).toEqual([
      '2026-12-07',
    ]);
    expect(datesSaid('What if Sunday.* is off on Dec 7?', sunday, ['Sunday.*']).dates).toEqual([
      '2026-12-07',
    ]);
  });

  it('日の言い方が無い・二つの日を言った時', () => {
    expect(dates('彩が休んだら？')).toEqual([]);
    expect(dates('What if Aya is off?')).toEqual([]);
    expect(dates('I may be home by 5')).toEqual([]);
    expect(dates('今日は無理だけど、明日休んだら？')).toEqual(['2026-11-29', '2026-11-30']);
    expect(dates('月曜か火曜に休んだら', wednesday)).toEqual(['2026-12-07', '2026-12-08']);
  });
});
