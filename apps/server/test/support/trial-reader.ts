// ブラウザと HTTP を通す試験用。指定した架空文にだけ、手で書いた別々の答えを返す。
// 実際のモデルを呼ばない。入力に含まれない日付や、別の文への録った結果の流用はしない。
import { ExtractionOutput } from '@maniau/core';
import type { NoticeReader } from '../../src/demo-sessions';

export const NOTICE_A = '2026年12月7日（月）は休校です。';
export const NOTICE_B = '2026年12月14日（月）は休校です。';
export const NOTICE_POSTPONED = '学習発表会は12月8日（火）に延期します。';
export const NOTICE_RELATIVE = 'あした、運動靴を持ってきてください。';

export function trialReader() {
  const calls: { sourceId: string; text: string }[] = [];
  const reader: NoticeReader = async (request) => {
    const sentences = request.source.sentences;
    const text = sentences.map((sentence) => sentence.text).join('');
    calls.push({ sourceId: request.source.id, text });
    const postponed = text === NOTICE_POSTPONED;
    const relative = text === NOTICE_RELATIVE;
    const date =
      text === NOTICE_A
        ? '2026-12-07'
        : text === NOTICE_B
          ? '2026-12-14'
          : postponed
            ? '2026-12-08'
            : undefined;
    const sentenceId = sentences[0]?.id;
    if ((!date && !relative) || !sentenceId || sentences.length !== 1)
      throw new Error('試験対象でない文');
    const output = ExtractionOutput.parse({
      items: [
        {
          id: 'i1',
          sentenceIds: [sentenceId],
          kind: relative ? 'belongings' : postponed ? 'event' : 'dayChange',
          written: text,
          date: date ?? null,
          writtenWeekday: relative ? 'none' : postponed ? 'tue' : 'mon',
          startTime: null,
          endTime: null,
          what: relative ? '運動靴' : postponed ? '学習発表会' : '休校',
          dayType: relative || postponed ? null : 'noSchool',
          deadline: null,
          audience: null,
          place: null,
          relativeDay: relative ? 'tomorrow' : 'none',
          conditionNodeId: null,
          inferred: false,
          familyAction: false,
          shape: 'none',
          effects: postponed
            ? [
                { type: 'resolveUnknown', unknownId: 'n1:u1', value: '2026-12-08', itemId: null },
                { type: 'replace', unknownId: null, value: null, itemId: 'n1:i2' },
              ]
            : [],
        },
      ],
      unknowns: [],
      conditions: [],
      irrelevantSentenceIds: [],
      ambiguities: [],
    });
    return {
      output,
      model: 'test-reader',
      promptVersion: 'test',
      inputHash: `test-${request.source.id}`,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  };
  return { reader, calls };
}
