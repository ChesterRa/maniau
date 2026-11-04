// 一言の原文の日の言い方から、コードが独立に日を求める。モデルの読んだ日は、モデルの写した言い方でなく家族の原文で
// 確かめる（モデルが言い方を落としても、黙って通さない）。よく使う言い方だけを読み、ほかは「分からない」として家族に
// 聞く（あらゆる言い方を読もうとしない）。
//
// 読む言い方：今日・本日・今夜・今晩、明日・あした、明後日・あさって、M月D日、M/D、年つきの日（2027年1月5日・2027/1/5・
// December 7, 2027）、（今週・来週・再来週の）○曜、today・tonight・tomorrow・the day after tomorrow、December 7・
// 7 December、(this・next) Monday、Monday next week。年を書いた月日は、その年で読む。読めない年（令和・'27）や、
// 「来年」「今年」のような年の言葉がある時は、年を落として読まず、月日を読まない（聞く）。
// 週の始まり（月曜か日曜か）で指す日が変わる、「next Monday」が次に来る月曜か来週の月曜か、今日がその曜日で今日か
// 来週か、の時は、当てはまる日を全部返す（呼ぶ側は、一つに決まらないので聞く）。
//
// 文字列から、その言葉が本当に日を言っているかまでは確かめられない。ここで求めた日は、モデルの日を受けるための要る
// 条件で、十分な条件ではない。家の人の名前のうち日の言い方を含む物（「明日香」）は、日として読まない。家の外の名前
// （「今日子先生」）などは見分けられないので、読んだ前提は家族の原文と並べて画面に出し、家族が確かめる。
import { addDays, LocalDate, weekdayOf } from '../time';

export interface SaidDates {
  /** 原文の言い方が指しうる日（重なりは除く）。言い方が無ければ空。 */
  dates: LocalDate[];
  /** 日を言った上で添えた曜日（「12/7（月）」の月曜。月曜 = 1 … 日曜 = 7）。日と合うかは呼ぶ側が確かめる。 */
  weekdays: number[];
}

const JA_WEEKDAYS = '月火水木金土日';
const EN_WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const EN_WEEKDAY = `(${EN_WEEKDAYS.join('|')})`;
const EN_MONTHS = [
  'jan(?:uary)?',
  'feb(?:ruary)?',
  'mar(?:ch)?',
  'apr(?:il)?',
  'may',
  'june?',
  'july?',
  'aug(?:ust)?',
  'sep(?:t(?:ember)?)?',
  'oct(?:ober)?',
  'nov(?:ember)?',
  'dec(?:ember)?',
];
const EN_MONTH = `(${EN_MONTHS.join('|')})`;
const monthOf = (name: string) => EN_MONTHS.findIndex((m) => new RegExp(`^${m}$`).test(name)) + 1;

/** 年月日の日。無い日（2/30 など）は undefined。 */
function at(year: number, month: number, day: number): LocalDate | undefined {
  const text = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return LocalDate.safeParse(text).success ? text : undefined;
}

/** 年の無い月日：去年・今年・来年のうち、今日に一番近い日（年末の「1/5」は来年、前の日の「11/28」は過ぎた日）。 */
function nearest(today: LocalDate, month: number, day: number): LocalDate | undefined {
  const year = Number(today.slice(0, 4));
  const distance = (d: LocalDate) => Math.abs(Date.parse(d) - Date.parse(today));
  return [year - 1, year, year + 1]
    .map((y) => at(y, month, day))
    .filter((d): d is LocalDate => d !== undefined)
    .sort((a, b) => distance(a) - distance(b))[0];
}

/** その週（0：今週、1：来週、2：再来週）のその曜日。週の始まりを月曜とする時と日曜とする時の両方。 */
function inWeek(today: LocalDate, weeks: number, weekday: number): LocalDate[] {
  const now = weekdayOf(today);
  const fromMonday = addDays(today, -(now - 1) + weeks * 7 + (weekday - 1));
  const fromSunday = addDays(today, -(now % 7) + weeks * 7 + (weekday % 7));
  return [fromMonday, fromSunday];
}

/** 次に来るその曜日。今日がその曜日なら、今日か来週か決められないので両方（after なら来週だけ）。 */
function coming(today: LocalDate, weekday: number, after = false): LocalDate[] {
  const ahead = (weekday - weekdayOf(today) + 7) % 7;
  if (ahead > 0) return [addDays(today, ahead)];
  return after ? [addDays(today, 7)] : [today, addDays(today, 7)];
}

export function datesSaid(
  text: string,
  today: LocalDate,
  names: readonly string[] = [],
): SaidDates {
  // 全角の数字・斜線・括弧を半角に、英字を小文字にそろえる。読んだ所は空白で消し、同じ所を二度読まない。
  const fold = (t: string) => t.normalize('NFKC').toLowerCase();
  let s = fold(text);
  // 日の言い方を含む名前（「明日香」）は、文字のとおりに（正規表現にせず）、長い名前から先に消す。
  const named = names
    .map(fold)
    .filter((n) => n.length > 0)
    .filter((n) => {
      const inName = datesSaid(n, today);
      return inName.dates.length > 0 || inName.weekdays.length > 0;
    })
    .sort((a, b) => b.length - a.length);
  for (const name of named) s = s.split(name).join(' '.repeat(name.length));
  const take = (re: RegExp, each: (m: RegExpMatchArray) => void) => {
    for (const m of s.matchAll(re)) each(m);
    s = s.replace(re, (m) => ' '.repeat(m.length));
  };
  const days: LocalDate[] = [];
  const add = (d: LocalDate | undefined) => {
    if (d !== undefined) days.push(d);
  };

  // 年の言葉（来年・今年 など）があれば、年を書かない月日の年が分からない（一番近い年にしない）。
  const yearWord = /再来年|来年|今年|去年|昨年|\b(?:next|this|last) year\b/.test(s);
  // 月日の後ろに書いた年（「December 7, 2027」「12/7, 2027」）は、その年で読む。読めない年（'27）なら読まない。
  const YEAR_AFTER = "(?:,?\\s*(\\d{4}|'\\d{2})(?![\\d:]))?";
  const monthDay = (month: number, day: number, year: string | undefined) => {
    if (year === undefined) {
      if (!yearWord) add(nearest(today, month, day));
    } else if (!year.startsWith("'")) add(at(Number(year), month, day));
  };
  take(/(?<!\d)(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?(?!\d)/g, (m) =>
    add(at(Number(m[1]), Number(m[2]), Number(m[3]))),
  );
  // 「令和9年12月7日」「来年12月7日」の月日は、年を落として読まない（年の後ろの月日は読まない）。
  take(/(?<![\d年])(\d{1,2})月(\d{1,2})日/g, (m) =>
    monthDay(Number(m[1]), Number(m[2]), undefined),
  );
  take(new RegExp(`(?<![\\d/年])(\\d{1,2})\\/(\\d{1,2})(?![\\d/])${YEAR_AFTER}`, 'g'), (m) =>
    monthDay(Number(m[1]), Number(m[2]), m[3]),
  );
  take(new RegExp(`\\b${EN_MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b${YEAR_AFTER}`, 'g'), (m) =>
    monthDay(monthOf(m[1] ?? ''), Number(m[2]), m[3]),
  );
  take(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${EN_MONTH}\\b\\.?${YEAR_AFTER}`, 'g'),
    (m) => monthDay(monthOf(m[2] ?? ''), Number(m[1]), m[3]),
  );
  take(/明後日|あさって|\bthe day after tomorrow\b|\bday after tomorrow\b/g, () =>
    add(addDays(today, 2)),
  );
  take(/明日|あした|\btomorrow\b/g, () => add(addDays(today, 1)));
  take(/今日|本日|今夜|今晩|\btoday\b|\btonight\b/g, () => add(today));

  const weekdays: number[] = [];
  if (days.length > 0) {
    // 日を言った上の曜日は、日に添えた曜日として返す（日を指す言い方にしない）。
    take(/([月火水木金土日])曜|\(([月火水木金土日])\)/g, (m) =>
      weekdays.push(JA_WEEKDAYS.indexOf(m[1] ?? m[2] ?? '') + 1),
    );
    take(new RegExp(`\\b${EN_WEEKDAY}\\b`, 'g'), (m) =>
      weekdays.push(EN_WEEKDAYS.indexOf(m[1] ?? '') + 1),
    );
    return { dates: [...new Set(days)], weekdays };
  }

  // 日を言っていなければ、曜日が日を指す。
  const weekOf = (word: string | undefined) =>
    word === '再来週' ? 2 : word === '来週' || word === 'next' ? 1 : 0;
  take(/(?:(再来週|来週|今週)[のは、,\s]*)?([月火水木金土日])曜/g, (m) => {
    const weekday = JA_WEEKDAYS.indexOf(m[2] ?? '') + 1;
    days.push(...(m[1] ? inWeek(today, weekOf(m[1]), weekday) : coming(today, weekday)));
  });
  take(new RegExp(`\\b(this|next)\\s+week'?s?\\s+(?:on\\s+)?${EN_WEEKDAY}\\b`, 'g'), (m) =>
    days.push(...inWeek(today, weekOf(m[1]), EN_WEEKDAYS.indexOf(m[2] ?? '') + 1)),
  );
  take(new RegExp(`\\b${EN_WEEKDAY}\\s+(?:of\\s+)?(this|next)\\s+week\\b`, 'g'), (m) =>
    days.push(...inWeek(today, weekOf(m[2]), EN_WEEKDAYS.indexOf(m[1] ?? '') + 1)),
  );
  take(new RegExp(`\\b(?:(this|next)\\s+)?${EN_WEEKDAY}\\b`, 'g'), (m) => {
    const weekday = EN_WEEKDAYS.indexOf(m[2] ?? '') + 1;
    // 「next Monday」は、次に来る月曜とも来週の月曜とも取れる（両方を返し、違えば聞く）。
    if (m[1] === 'next') days.push(...coming(today, weekday, true), ...inWeek(today, 1, weekday));
    else if (m[1] === 'this') days.push(...inWeek(today, 0, weekday));
    else days.push(...coming(today, weekday));
  });
  return { dates: [...new Set(days)], weekdays };
}
