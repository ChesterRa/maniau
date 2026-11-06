// 名前だけの試用で、家の場所を住所から入れる時の、地域の欄（都道府県・市区町村・町名）の確かめ。家の情報に残し、
// 周りを調べる時に Claude に送るのは、家族がこの欄に打った文だけ（丁目・番地は別の欄に打ち、地図の照会にだけ使う）。
// 地図（Google）の応答から作らない（Google の中身は、残さず Claude にも送らない決まり）。
//
// 自動で番地を切り落とすことはしない（漢数字の番地と町名を見分け切れないので、それを隠す仕組みにしない）。番地に
// 見える書き方があれば、受けずに下の欄へ回してもらう。

/**
 * 地域の欄の文と、検索の地域の目安にする都道府県（頭に書いてあった時だけ）。市区町村の名前は切り出さない（武蔵村山市・
 * 東村山市のように、名前の中に市・町・村を含む物を、字の決まりでは正しく切れないので）。
 */
export interface AddressArea {
  area: string;
  prefecture?: string;
}

/** 地域の欄・番地の欄の長さの上限（字）。 */
export const MAX_AREA_LENGTH = 60;
export const MAX_ADDRESS_DETAIL_LENGTH = 60;

const PREFECTURE = /^(東京都|北海道|京都府|大阪府|[^都道府県市区町村]{2,3}県)/;
/** 市区町村の字（郡の中の町村を含む）が、頭より後にあるか。 */
const HAS_CITY = /.[市区町村]/;
/**
 * 番地・郵便番号に見える書き方：数字（半角・全角）、丁目、番地、漢数字の「〇番」（一番町・一番丁のような町名は
 * 除く）、漢数字の「〇号」。
 */
const DETAIL =
  /[0-9０-９]|丁目|番地|[一二三四五六七八九十〇百千]+番(?![町丁])|[一二三四五六七八九十〇百千]+号/;

/**
 * 地域の欄を確かめる。空白を除き、番地に見える書き方があれば detail、市区町村が読めなければ noCity（町名だけ・
 * 都道府県だけ・英字の住所・長すぎる物など）。
 */
export function checkHomeArea(text: string): AddressArea | 'detail' | 'noCity' {
  const area = text.normalize('NFC').replace(/\s+/g, '');
  if (DETAIL.test(area)) return 'detail';
  if (area.length === 0 || area.length > MAX_AREA_LENGTH) return 'noCity';
  const prefecture = PREFECTURE.exec(area)?.[1];
  const rest = prefecture ? area.slice(prefecture.length) : area;
  if (!HAS_CITY.test(rest)) return 'noCity';
  return { area, ...(prefecture ? { prefecture } : {}) };
}
