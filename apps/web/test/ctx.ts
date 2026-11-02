// 試験の画面の材料：デモの段を、その大人・その言葉で、サーバーと同じ見せる物から組む。
import { DEMO_STAGES, demoEvents, loadDemoData } from '../../server/src/demo';
import { viewFor } from '../../server/src/views';
import i18n from '../src/i18n';
import type { Ctx } from '../src/screens';

export const demoData = loadDemoData();

/** at を渡すと、その段の事象を、別の時刻に見る（決め時の前後の境を試す）。 */
export function ctxFor(stageId: string, memberId: string, lang: 'ja' | 'en', at?: string): Ctx {
  const stage = DEMO_STAGES.find((s) => s.id === stageId);
  const me = demoData.household.members.find((m) => m.id === memberId);
  if (!stage || !me) throw new Error(`段か大人が無い：${stageId}・${memberId}`);
  const view = viewFor(demoEvents(stage.id), me.id, at ?? stage.now);
  return {
    plan: view.plan,
    household: view.household,
    today: view.today,
    items: view.items,
    sources: new Map(view.sources.map((s) => [s.id, s])),
    readings: demoData.readings,
    me,
    lang,
    tz: view.household.timeZone,
    now: at ?? view.now,
    t: i18n.getFixedT(lang),
    outbound: (lng) => i18n.getFixedT(lng),
    send: async () => ({ status: 'ok' }),
    go: () => {},
  };
}
