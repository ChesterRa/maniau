// デモの筋（docs/plan/02-product.md §2）を、事象の列として組み立てる。
// 読み取りの出力は、手で書いた「正しい読み取りの形」で、モデルの出力ではない。
// エンジンの試験の入力に使う。モデルの読み取りの確かめは、録った応答で別に行う。
import { readFileSync } from 'node:fs';
import { DomainEvent, type Extraction, Household, type Source, splitSentences } from '../../src';

const ROOT = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');

export const household = Household.parse(JSON.parse(read('data/demo/household.json')));

export const notice1: Source = {
  id: 'n1',
  version: 1,
  receivedAt: '2026-11-25T19:30+09:00',
  sender: 'school',
  senderPlaceId: 'school',
  language: 'ja',
  medium: 'text',
  title: '学習発表会のお知らせ',
  sentences: splitSentences(read('data/demo/notices/2026-11-25-happyokai.txt'), 'n1'),
};

export const notice2: Source = {
  id: 'n2',
  version: 1,
  receivedAt: '2026-12-04T17:52+09:00',
  sender: 'school',
  senderPlaceId: 'school',
  language: 'ja',
  medium: 'text',
  title: '学習発表会の延期について',
  sentences: splitSentences(read('data/demo/notices/2026-12-04-enki.txt'), 'n2'),
};

/** n1 の正しい読み取りの形。文 ID は splitSentences の番号。 */
export const extraction1: Extraction = {
  sourceId: 'n1',
  unknowns: [
    {
      id: 'u-date',
      label: '学習発表会の実施日',
      values: ['2026-12-05', '2026-12-08'],
      kind: 'schedule',
    },
  ],
  conditions: [
    { id: 'c-held-5', kind: 'eq', unknownId: 'u-date', value: '2026-12-05' },
    { id: 'c-held-8', kind: 'eq', unknownId: 'u-date', value: '2026-12-08' },
  ],
  items: [
    {
      id: 'i1',
      sourceId: 'n1',
      sentenceIds: ['n1#6'],
      kind: 'event',
      written: '12月5日(土)に学習発表会を行います。',
      interpretation: { date: '2026-12-05', writtenWeekday: 6, what: '学習発表会' },
      conditionNodeId: 'c-held-5',
      evidence: 'stated',
      effects: [],
    },
    {
      id: 'i2',
      sourceId: 'n1',
      sentenceIds: ['n1#7'],
      kind: 'event',
      written: '1年生の発表は9時20分からです。',
      interpretation: { startTime: '09:20', what: '学習発表会（1年生の発表）', audience: '1年生' },
      evidence: 'stated',
      effects: [],
    },
    {
      id: 'i3',
      sourceId: 'n1',
      sentenceIds: ['n1#8'],
      kind: 'belongings',
      written: '衣装として、白い長袖シャツを用意してください。',
      interpretation: { what: '白い長袖シャツ' },
      evidence: 'stated',
      effects: [],
    },
    {
      id: 'i4',
      sourceId: 'n1',
      sentenceIds: ['n1#9'],
      kind: 'dayChange',
      written: '5日(土)に行った場合、12月7日(月)は振替休業日です。',
      interpretation: {
        date: '2026-12-07',
        writtenWeekday: 1,
        dayType: 'noSchool',
        what: '振替休業日',
      },
      conditionNodeId: 'c-held-5',
      evidence: 'stated',
      effects: [],
    },
    {
      id: 'i5',
      sourceId: 'n1',
      sentenceIds: ['n1#10'],
      kind: 'event',
      written: '感染症の流行状況により延期する場合は、12月8日(火)に行います。',
      interpretation: { date: '2026-12-08', writtenWeekday: 2, what: '学習発表会' },
      conditionNodeId: 'c-held-8',
      evidence: 'stated',
      effects: [],
    },
    {
      id: 'i6',
      sourceId: 'n1',
      sentenceIds: ['n1#11'],
      kind: 'dayChange',
      written: '延期した場合、7日(月)は通常授業とします。',
      interpretation: { date: '2026-12-07', writtenWeekday: 1, dayType: 'normalSchool' },
      conditionNodeId: 'c-held-8',
      evidence: 'stated',
      effects: [],
    },
    {
      id: 'i7',
      sourceId: 'n1',
      sentenceIds: ['n1#12'],
      kind: 'contact',
      written: 'ご不明な点は、担任までお問い合わせください。',
      interpretation: { what: '担任' },
      evidence: 'stated',
      effects: [],
    },
  ],
  irrelevantSentenceIds: ['n1#1', 'n1#2', 'n1#3', 'n1#4', 'n1#5'],
  ambiguities: [],
};

/** n2（延期の連絡）の正しい読み取りの形。前の事項への作用を ID で返す。 */
export const extraction2: Extraction = {
  sourceId: 'n2',
  unknowns: [],
  conditions: [],
  items: [
    {
      id: 'j1',
      sourceId: 'n2',
      sentenceIds: ['n2#5'],
      kind: 'event',
      written: '感染症の流行のため、学習発表会は12月8日(火)に行います。',
      interpretation: { date: '2026-12-08', writtenWeekday: 2, what: '学習発表会' },
      evidence: 'stated',
      effects: [{ type: 'resolveUnknown', unknownId: 'u-date', value: '2026-12-08' }],
    },
    {
      id: 'j2',
      sourceId: 'n2',
      sentenceIds: ['n2#6'],
      kind: 'dayChange',
      written: '12月7日(月)は通常授業です。',
      interpretation: { date: '2026-12-07', writtenWeekday: 1, dayType: 'normalSchool' },
      evidence: 'stated',
      effects: [{ type: 'replace', itemId: 'i6' }],
    },
    {
      id: 'j3',
      sourceId: 'n2',
      sentenceIds: ['n2#7'],
      kind: 'belongings',
      written: '衣装は、先日のお知らせのとおりご用意ください。',
      interpretation: { what: '白い長袖シャツ' },
      evidence: 'stated',
      effects: [{ type: 'replace', itemId: 'i3' }],
    },
  ],
  irrelevantSentenceIds: ['n2#1', 'n2#2', 'n2#3', 'n2#4'],
  ambiguities: [],
};

type Envelope = Pick<
  DomainEvent,
  'id' | 'householdId' | 'seq' | 'version' | 'occurredAt' | 'recordedAt' | 'actorId'
>;

export class EventLog {
  readonly events: DomainEvent[] = [];
  private seq = 0;

  add<T extends DomainEvent['type']>(
    type: T,
    at: string,
    actorId: string,
    body: Omit<Extract<DomainEvent, { type: T }>, keyof Envelope | 'type'>,
  ): this {
    this.seq += 1;
    const envelope: Envelope = {
      id: `e${this.seq}`,
      householdId: household.id,
      seq: this.seq,
      version: 1,
      occurredAt: at,
      recordedAt: at,
      actorId,
    };
    // 型の検査を通して積む（試験の事象も、本番と同じ契約に従う）。
    this.events.push(DomainEvent.parse({ ...envelope, type, ...body }));
    return this;
  }
}

/** お知らせが届き、読み取った所まで。 */
export function noticeArrived(): EventLog {
  return new EventLog()
    .add('householdSet', '2026-11-24T21:00+09:00', 'a', { household })
    .add('noticeReceived', '2026-11-25T19:30+09:00', 'b', { source: notice1 })
    .add('modelOutputRecorded', '2026-11-25T19:30+09:00', 'system', {
      call: 'extract',
      model: 'hand-written',
      promptVersion: 'fixture',
      inputHash: 'fixture-n1',
      sourceId: 'n1',
      output: extraction1,
    });
}
