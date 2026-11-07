// 暦の書き出し（ICS、RFC 5545）。02-product:106 の約束（今週は確定した事の書き出しまで）が、11/7 の体検で未実装と
// 分かったので足す。ここは形だけを作る（何を書き出すかは、よていの行の firm と at で決める）。
// 時刻のある予定は UTC で書き（VTIMEZONE を持たない）、日だけの予定は VALUE=DATE で書く。終わりが分からない予定に
// 終わりを作らない。行は 75 オクテットで折り、CRLF でつなぐ。

export type IcsEvent = {
  /** 同じ予定をもう一度書き出した時に、同じ物と分かる名前。 */
  uid: string;
  summary: string;
  description?: string;
  /** 日だけの予定（YYYY-MM-DD）。 */
  date?: string;
  /** 時刻のある予定（エポックのミリ秒）。 */
  start?: number;
  end?: number;
};

/** 文の中の特別な字を逃がす（\ ; , と改行）。 */
export function icsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** 一行を 75 オクテットごとに折る（続きの行は空白で始める）。多バイトの字を途中で切らない。 */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = '';
  let size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    // 続きの行は頭の空白の分だけ短くする。
    const limit = parts.length === 0 ? 75 : 74;
    if (size + bytes > limit) {
      parts.push(current);
      current = '';
      size = 0;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

const utc = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');

const dateValue = (date: string) => date.replace(/-/g, '');

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function toIcs(events: readonly IcsEvent[], stamp: number, name: string): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//maniau//schedule//JA',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(name)}`,
  ];
  for (const event of events) {
    if (event.date === undefined && event.start === undefined) continue;
    lines.push('BEGIN:VEVENT', `UID:${icsText(event.uid)}`, `DTSTAMP:${utc(stamp)}`);
    if (event.start !== undefined) {
      lines.push(`DTSTART:${utc(event.start)}`);
      if (event.end !== undefined && event.end > event.start) lines.push(`DTEND:${utc(event.end)}`);
    } else if (event.date !== undefined) {
      lines.push(
        `DTSTART;VALUE=DATE:${dateValue(event.date)}`,
        `DTEND;VALUE=DATE:${dateValue(nextDay(event.date))}`,
      );
    }
    lines.push(`SUMMARY:${icsText(event.summary)}`);
    if (event.description) lines.push(`DESCRIPTION:${icsText(event.description)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
