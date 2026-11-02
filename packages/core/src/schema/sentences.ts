// お知らせの文を、文 ID の付いた文に分ける。読み取りの出典（文 ID）と、文の網羅の確かめに使う。
// 行ごとに、句点（。）で区切る。句点の無い行（日付、宛名、題）も一つの文とする。
import type { Sentence } from './source';

export function splitSentences(text: string, sourceId: string): Sentence[] {
  const sentences: Sentence[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.match(/[^。]+。?/g) ?? [];
    for (const part of parts) {
      const sentence = part.trim();
      if (sentence) sentences.push({ id: `${sourceId}#${sentences.length + 1}`, text: sentence });
    }
  }
  return sentences;
}
