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

void i18n.use(initReactI18next).init({
  resources: { ja: { translation: ja }, en: { translation: en } },
  lng: 'ja',
  fallbackLng: 'ja',
  interpolation: { escapeValue: false },
});

// 大人ごとに選んだ言葉を覚える。今は端末の中だけ（後で成員の情報に移す）。
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
