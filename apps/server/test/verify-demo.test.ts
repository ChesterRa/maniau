// デモの各段の計画を、エンジンと別に書いた検証器にかける（エンジンと検証器をつなぐ試験）。
// 検証器は道のりや要件の網羅を確かめられないので、全体は「未判定」になり得る。違反が無いことを確かめる。
import { verifyPlan } from '@maniau/verify';
import { describe, expect, it } from 'vitest';
import { DEMO_STAGES, demoEvents, demoPlan } from '../src/demo';

describe('デモの計画を検証器にかける', () => {
  for (const stage of DEMO_STAGES) {
    it(`${stage.id}（${stage.now}）：違反が無い`, () => {
      const { household, plan } = demoPlan(stage.id);
      const report = verifyPlan({ household, plan, events: demoEvents(stage.id) });
      expect(report.issues.filter((i) => i.kind === 'violation')).toEqual([]);
      expect(report.status).not.toBe('violation');
    });
  }
});
