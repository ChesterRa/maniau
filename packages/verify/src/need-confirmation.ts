// モデルが読んだ「すること」は、家族がその読み取りを確かめるまで期限や手配にしない。
// 計画の unconfirmed 印を根拠にせず、事象から採用された読み取りと言明を照らす。
import type { PlanResult } from '@maniau/core';
import type { FactState } from './facts';
import type { History } from './history';
import type { Collector } from './report';

export function checkNeedConfirmation(
  plan: PlanResult,
  facts: FactState,
  history: History,
  report: Collector,
): void {
  for (const item of facts.items.values()) {
    if (item.kind !== 'need') continue;
    const status = facts.needConfirmation.get(item.id);
    if (facts.staleItems.has(item.id) && status !== 'stated') {
      const reading = facts.sourceReadingSeq.get(item.sourceId);
      const corrected = history.events.findLast(
        (event) => event.type === 'transcriptionCorrected' && event.sourceId === item.sourceId,
      );
      const stated = history.events.findLast(
        (event) =>
          (event.type === 'itemConfirmed' ||
            event.type === 'itemCorrected' ||
            event.type === 'itemDismissed') &&
          event.itemId === item.id,
      );
      if (
        history.complete &&
        reading !== undefined &&
        corrected !== undefined &&
        stated !== undefined &&
        corrected.seq > reading &&
        stated.seq > corrected.seq
      )
        report.violation(
          'need_stale_confirmation',
          item.id,
          '文を直して読み直す前の事項を確かめている。',
        );
      else
        report.undetermined(
          'need_confirmation_unverified',
          item.id,
          '文の直しの後の読み取りを確かめられない。',
        );
      continue;
    }
    if (status !== 'pending') continue;
    // 撤回・確かな取消しを受けた事項には、確認を求めない。
    if (facts.active.get(item.id) === false) continue;
    if (!history.complete) {
      report.undetermined(
        'need_confirmation_unverified',
        item.id,
        '読み取りに対する家族の確認を事象から確かめられない。',
      );
      continue;
    }
    const requirements = plan.requirements.filter(
      (entry) => entry.kind === 'need' && entry.basis.itemIds.includes(item.id),
    );
    if (requirements.length === 0) {
      report.violation(
        'need_confirmation_missing',
        item.id,
        '確認していない読み取りを、確認する要件として残していない。',
      );
      continue;
    }
    for (const requirement of requirements) {
      // 条件の読みによって live=false になることはある。確認札の表示は計画とは別に画面で確かめる。
      if (requirement.unconfirmed !== true || requirement.by || requirement.date)
        report.violation(
          'need_unconfirmed_requirement_mismatch',
          requirement.key,
          '確認していない読み取りを確認待ちとせず、または確定した日時を付けている。',
        );
      if (plan.arrangements.some((entry) => entry.requirementKey === requirement.key))
        report.violation(
          'need_unconfirmed_arrangement',
          requirement.key,
          '確認していない読み取りから手配を作っている。',
        );
    }
    for (const task of plan.tasks) {
      // 過去に送った依頼の後始末は、未確認の読み取りから新たに作る作業とは分ける。
      if (task.live && !task.cancels && task.basis.itemIds.includes(item.id))
        report.violation(
          'need_unconfirmed_task',
          task.key,
          '確認していない読み取りから作業を作っている。',
        );
    }
  }
}
