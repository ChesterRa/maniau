// 家の場所の地域の欄（家に残し、Claude に送る部分）の確かめ。番地に見える書き方は受けない。
import { describe, expect, it } from 'vitest';
import { checkHomeArea } from '../src/reading/address';

describe('家の場所の地域の欄', () => {
  it('頭の都道府県を読む（空白は除く）。市区町村の名前は切り出さない', () => {
    expect(checkHomeArea('東京都 江東区 東陽')).toEqual({
      area: '東京都江東区東陽',
      prefecture: '東京都',
    });
    expect(checkHomeArea('神奈川県横浜市港北区日吉本町')).toEqual({
      area: '神奈川県横浜市港北区日吉本町',
      prefecture: '神奈川県',
    });
    expect(checkHomeArea('江東区豊洲')).toEqual({ area: '江東区豊洲' });
  });

  it('町名の中の漢数字や、名前に市・町・村を含む市町村も、打ったままの地域として受ける', () => {
    for (const area of [
      '東京都千代田区一番町',
      '宮城県仙台市青葉区一番町',
      '東京都八王子市元本郷町',
      '三重県四日市市諏訪町',
      '新潟県十日町市千歳町',
      '千葉県市川市八幡',
      '東京都武蔵村山市本町',
      '東京都東村山市本町',
      '山形県東村山郡中山町長崎',
    ]) {
      expect(checkHomeArea(area), area).toEqual({ area, prefecture: area.slice(0, 3) });
    }
  });

  it('番地・郵便番号に見える書き方は受けない（数字・丁目・番地・漢数字の番と号）', () => {
    for (const text of [
      '東京都江東区東陽4-11-28',
      '東京都江東区東陽４丁目',
      '〒135-0016東京都江東区東陽',
      '江東区豊洲二丁目',
      '東京都千代田区千代田一番一号',
      '京都府京都市上京区京都御苑三番',
      '東京都江東区東陽四番地',
    ]) {
      expect(checkHomeArea(text), text).toBe('detail');
    }
  });

  it('市区町村が読めない物は受けない（町名だけ・都道府県だけ・英字・空・長すぎる物）', () => {
    for (const text of [
      '豊洲',
      '東京都',
      'Toyo, Koto-ku, Tokyo',
      '  ',
      `東京都江東区${'東'.repeat(60)}`,
    ]) {
      expect(checkHomeArea(text), text).toBe('noCity');
    }
  });
});
