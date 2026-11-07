// 暦の書き出し（ICS）の形：日だけの予定と時刻のある予定、終わりを作らない、特別な字を逃がす、75 オクテットで折る。
import { expect, it } from 'vitest';
import { foldLine, icsText, toIcs } from '../src/ics';

const STAMP = Date.parse('2026-11-25T19:31+09:00');

it('日だけの予定は次の日までの VALUE=DATE、時刻のある予定は UTC。終わりが分からない予定に終わりを作らない', () => {
  const ics = toIcs(
    [
      { uid: 'item:n1:i6.h@maniau', summary: '振替休業日', date: '2026-12-07' },
      {
        uid: 'task:t1.h@maniau',
        summary: '彩：学童へ送る',
        start: Date.parse('2026-12-07T08:10+09:00'),
        end: Date.parse('2026-12-07T08:40+09:00'),
      },
      {
        uid: 'deadline:o1.h@maniau',
        summary: '決め時',
        start: Date.parse('2026-11-30T17:20+09:00'),
      },
    ],
    STAMP,
    'まにあう',
  );
  const lines = ics.split('\r\n');
  expect(lines[0]).toBe('BEGIN:VCALENDAR');
  expect(lines).toContain('DTSTAMP:20261125T103100Z');
  expect(lines).toContain('DTSTART;VALUE=DATE:20261207');
  expect(lines).toContain('DTEND;VALUE=DATE:20261208');
  expect(lines).toContain('DTSTART:20261206T231000Z');
  expect(lines).toContain('DTEND:20261206T234000Z');
  expect(lines).toContain('DTSTART:20261130T082000Z');
  // 決め時には終わりを書かない。
  const deadline = ics.slice(ics.indexOf('UID:deadline'));
  expect(deadline.slice(0, deadline.indexOf('END:VEVENT'))).not.toContain('DTEND');
  expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  // 日も時刻も無い物は書かない。
  expect(toIcs([{ uid: 'x', summary: 'x' }], STAMP, 'm')).not.toContain('BEGIN:VEVENT');
});

it('特別な字を逃がし、長い行は多バイトの字を切らずに 75 オクテットで折る', () => {
  expect(icsText('a;b,c\\d\ne')).toBe('a\\;b\\,c\\\\d\\ne');
  const long = `SUMMARY:${'あ'.repeat(40)}`;
  const folded = foldLine(long);
  const parts = folded.split('\r\n ');
  expect(parts.length).toBeGreaterThan(1);
  const encoder = new TextEncoder();
  expect(encoder.encode(parts[0]).length).toBeLessThanOrEqual(75);
  for (const part of parts.slice(1)) expect(encoder.encode(part).length).toBeLessThanOrEqual(74);
  expect(parts.join('')).toBe(long);
});
