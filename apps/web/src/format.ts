// 日付と時刻を Intl で整える（文を連結して組み立てない。日付の形だけを作る）。
import { toEpochMinutes } from '@maniau/core';
import type { UiLanguage } from './i18n';

const locale = (language: UiLanguage) => (language === 'ja' ? 'ja-JP' : 'en-US');
const isLocalDate = (value: string) => value.length === 10;
const toDate = (value: string) =>
  isLocalDate(value) ? new Date(`${value}T12:00:00Z`) : new Date(toEpochMinutes(value) * 60_000);

/** 11/30（月） / Mon 11/30 */
export function formatDay(value: string, language: UiLanguage, timeZone: string): string {
  const parts = new Intl.DateTimeFormat(locale(language), {
    timeZone: isLocalDate(value) ? 'UTC' : timeZone,
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  }).formatToParts(toDate(value));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return language === 'ja'
    ? `${get('month')}/${get('day')}（${get('weekday')}）`
    : `${get('weekday')} ${get('month')}/${get('day')}`;
}

/** 17:20 / 5:20 PM */
export function formatTime(value: string, language: UiLanguage, timeZone: string): string {
  return new Intl.DateTimeFormat(locale(language), {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: language !== 'ja',
  }).format(toDate(value));
}

export function formatDayTime(value: string, language: UiLanguage, timeZone: string): string {
  return `${formatDay(value, language, timeZone)} ${formatTime(value, language, timeZone)}`;
}

/** 11月25日（水） / Wednesday, November 25 */
export function formatLongDay(value: string, language: UiLanguage, timeZone: string): string {
  if (language === 'ja') {
    // month: 'long' の部品は、ICU によって「11」だけ（「月」は区切りの側）になるので、数で受けて並べる。
    const parts = new Intl.DateTimeFormat('ja-JP', {
      timeZone: isLocalDate(value) ? 'UTC' : timeZone,
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
    }).formatToParts(toDate(value));
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((p) => p.type === type)?.value ?? '';
    return `${get('month')}月${get('day')}日（${get('weekday')}）`;
  }
  return new Intl.DateTimeFormat('en-US', {
    timeZone: isLocalDate(value) ? 'UTC' : timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(toDate(value));
}

/** その地域の日付（YYYY-MM-DD）。 */
export function localDate(value: string, timeZone: string): string {
  if (isLocalDate(value)) return value;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(toDate(value));
}

/** from の日から to の日まで、暦で何日か（同じ日なら 0）。 */
export function daysBetween(from: string, to: string, timeZone: string): number {
  const a = Date.parse(`${localDate(from, timeZone)}T00:00:00Z`);
  const b = Date.parse(`${localDate(to, timeZone)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function minutesBetween(from: string, to: string): number {
  return toEpochMinutes(to) - toEpochMinutes(from);
}

export function hourOf(value: string, timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(
      toDate(value),
    ),
  );
}
