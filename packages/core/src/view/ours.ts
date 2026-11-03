// 家族の物かを、家庭の情報と事項から決める（エンジンと画面で同じ決まりを使う）。
import type { Household } from '../schema/household';
import type { Item } from '../schema/source';

/** 当番が、うちの番か。others は作業にしない。unsure は作業にして、対象を添えて家族に確かめてもらう。 */
export type DutyTurn = 'ours' | 'others' | 'unsure';

/** 家族の言明（「うちの番です」「うちの番ではない」）と、言った時の用件と対象（turnStated）。 */
export interface TurnStatement {
  ours: boolean;
  what: string;
  audience: string | null;
}

/** 名前や用件を比べる形（全角・半角と空白をそろえる）。 */
const form = (text: string) => text.normalize('NFKC').replace(/\s+/g, '');

/** みんなや役を指す言葉。これがあれば、ほかの家だけの番とは言えない（保護者全員、1年生、役員さん）。 */
const GROUP =
  /全員|みなさん|皆さん|皆様|みなさま|各家庭|全家庭|ご家庭|保護者|役員|委員|有志|希望者|の方|方々|クラス|学年|年生|組/;
/**
 * 名指しだけで書かれた対象（さくらさん・みおさんのおうち、ゆうくんと りこさん）。名指しと、つなぎの言葉と、
 * 家を指す後ろの言葉を除いて、何も残らない物。
 */
const NAMES_ONLY =
  /^(?:[^・、，,／/＆&]+?(?:さん|くん|ちゃん|さま|様)(?:のおうち|のお家|の家|家|宅)?(?:[・、，,／/＆&]|と|及び|および)?)+$/u;

/** 名前の後ろに続いてよい物（さん・のおうち・つなぎ・終わり）。「陽菜子さん」の「陽菜」は、家の子としない。 */
const AFTER_NAME = /^(?:さん|くん|ちゃん|さま|様|の|家|宅|[・、，,／/＆&と]|$)/u;

function namesOurChild(household: Household, audience: string | undefined): boolean {
  if (audience === undefined) return false;
  const written = form(audience);
  return household.members.some((m) => {
    if (m.kind !== 'child' || !m.active) return false;
    const name = form(m.name);
    if (name === '') return false;
    for (let at = written.indexOf(name); at >= 0; at = written.indexOf(name, at + 1)) {
      if (AFTER_NAME.test(written.slice(at + name.length))) return true;
    }
    return false;
  });
}

/**
 * 家族の言明が今も当たるなら、その言明（うちの番か）。言った時と用件か対象が違えば（直された）、当てない。
 */
export function statedTurn(item: Item, stated: TurnStatement | undefined): boolean | undefined {
  if (!stated) return undefined;
  const what = item.interpretation.what ?? item.written;
  const audience = item.interpretation.audience ?? null;
  return stated.what === what && stated.audience === audience ? stated.ours : undefined;
}

/**
 * うちの番の当番か。家族の言明（stated）が今も当たれば、それに従う（ours か others）。無ければ書き方で決める。
 * - ours：誰の番かが書かれていない（連絡帳の「来週は配車当番です」）、家の子の名前がある。読んだ中身を
 *   確かめた・直しただけでは、うちの番としない。
 * - others：対象がほかの人の名指しだけで（さくらさん・みおさんのおうち）、同じお知らせの同じ用件の当番に、
 *   家の子の名前で書かれた行が別にある（当番表の、うちの行が別にある）。sameSource には、今も効いていて、
 *   確かで、条件の無い行だけを渡す（条件で外れた・条件しだい・確かでない行を、ほかの家の番の根拠にしない）。
 * - unsure：ほかは全部（保護者全員、学年、名指しとほかの言葉の混ざった物）。作業にして、対象を添えて確かめて
 *   もらう。
 * 決まりは推し量り（ヒューリスティック）で、当番表が同じ書き方（子の名前）で家を並べる前提に立つ。名字で
 * 書かれた行がうちの物でも others になりうる。家の子の名前は、後ろに「さん」「のおうち」・つなぎ・終わりが
 * 続く時だけ見つけたとする（「陽菜子さん」は「陽菜」ではない）。それでも、名前の終わりが同じ別の子（陽菜 と
 * 菜）は ours になりうる。どちらも家族が直せるようにする（others は出典の画面の「うちの番です」、当番の札は
 * どれも「うちの番ではない」）。
 */
export function dutyTurn(
  household: Household,
  item: Item,
  sameSource: readonly Item[],
  stated: TurnStatement | undefined = undefined,
): DutyTurn {
  const said = statedTurn(item, stated);
  if (said !== undefined) return said ? 'ours' : 'others';
  const audience = item.interpretation.audience;
  const what = item.interpretation.what ?? item.written;
  if (audience === undefined || audience.trim() === '') return 'ours';
  if (namesOurChild(household, audience)) return 'ours';
  const written = form(audience);
  if (GROUP.test(written) || !NAMES_ONLY.test(written)) return 'unsure';
  const sameWhat = form(what);
  const oursElsewhere = sameSource.some(
    (other) =>
      other.id !== item.id &&
      other.sourceId === item.sourceId &&
      other.kind === 'duty' &&
      other.interpretation.familyAction === true &&
      form(other.interpretation.what ?? other.written) === sameWhat &&
      namesOurChild(household, other.interpretation.audience),
  );
  return oursElsewhere ? 'others' : 'unsure';
}
