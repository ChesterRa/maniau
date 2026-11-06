// 画面の言葉。地域・時区・外に出す文の言葉・原文の言葉とは別に扱う（docs/design/01-model.md §13）。
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import ja from './locales/ja.json';

export const UI_LANGUAGES = ['ja', 'en'] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

export function isUiLanguage(value: unknown): value is UiLanguage {
  return value === 'ja' || value === 'en';
}

// この端末で、初めの画面やデモで最後に選んだ言葉。開き直した時の初めの言葉にする（試用を始める前に選んだ言葉は、
// まだ大人がいないので大人ごとには覚えられず、これが無いと開き直すと日本語に戻る）。大人ごとに覚えた言葉があれば、
// そちらを使う（下の rememberedLanguage）。
const DEVICE_KEY = 'maniau.uiLanguage';

function deviceLanguage(): UiLanguage {
  try {
    const value = window.localStorage.getItem(DEVICE_KEY);
    return isUiLanguage(value) ? value : 'ja';
  } catch {
    return 'ja';
  }
}

export function rememberDeviceLanguage(language: UiLanguage): void {
  try {
    window.localStorage.setItem(DEVICE_KEY, language);
  } catch {
    // 覚えられなくても、画面はそのまま使える。
  }
}

void i18n.use(initReactI18next).init({
  resources: { ja: { translation: ja }, en: { translation: en } },
  lng: deviceLanguage(),
  fallbackLng: 'ja',
  interpolation: { escapeValue: false },
});

// 大人ごとに選んだ言葉を覚える。今は端末の中だけ（後で成員の情報に移す）。空から始めた試用では、試用の ID を前に付けた鍵を渡す。
const storageKey = (memberId: string) => `maniau.uiLanguage.${memberId}`;

export function rememberedLanguage(memberId: string, fallback: UiLanguage): UiLanguage {
  try {
    const value = window.localStorage.getItem(storageKey(memberId));
    return isUiLanguage(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function rememberLanguage(memberId: string, language: UiLanguage): void {
  try {
    window.localStorage.setItem(storageKey(memberId), language);
  } catch {
    // 覚えられなくても、画面はそのまま使える。
  }
}

export default i18n;
