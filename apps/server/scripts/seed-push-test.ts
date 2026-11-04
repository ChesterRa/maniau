// 架空のデモ家庭だけの専用 DB に、現在の 90 分後が締切の架空の提出物を一度だけ足す。
// 家族用の HTTP 口や画面は増やさない。実際の Push は、本人が通知を許可した端末に通常の仕事が送る。
// 先に専用 DB へ setup:household --kind test でデモ家庭を作り、試す端末で通知をオンにする。
// 接続先は環境変数から受け取る（値を表示しない）。実行：
//   pnpm --filter @maniau/server exec tsx scripts/seed-push-test.ts
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  type DateTime,
  formatDateTime,
  Household,
  notificationHistory,
  notificationIntents,
  splitSentences,
  toEpochMinutes,
  validateHousehold,
} from '@maniau/core';
import { computePlan } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { nowIn } from '../src/clock';
import { households, pushSubscriptions } from '../src/db/schema';
import { type Db, postgresStore } from '../src/db/store';
import { sendGate } from '../src/gate';

const DEMO_ID = 'demo-toyosu';
const SOURCE_ID = 't005-push-notice';
const ITEM_ID = 't005-push-item';
const FIXTURE_SHA256 = 'a7eaaaf0fc959fe5a40cdb1e6e7d0ed3eebf69d314d53bb0575d1b69377e20ae';
const ERRORS: Readonly<Record<string, string>> = {
  database_missing: '接続先が設定されていません。',
  fixture_changed: '架空のデモ材料が固定した物と違います。',
  fixture_invalid: '架空のデモ材料の形が違います。',
  outside_test_hours: '通知試験は、家庭の時区の 7 時から 22 時の間に行ってください。',
  not_dedicated_test_database: '架空の test 家庭一つだけの専用 DB ではありません。',
  not_empty_demo_household: '家庭の内容か事象が、架空の初期状態と違います。',
  no_active_subscription: '通知を受ける大人の端末が登録されていません。',
  fixture_gate_failed: '試験の意図か送る前の検証を確かめられませんでした。',
};

/** 決め打ちの架空デモだけを使う。書き換わった材料は使わない。 */
function demoHousehold() {
  const bytes = readFileSync(new URL('../../../data/demo/household.json', import.meta.url));
  if (createHash('sha256').update(bytes).digest('hex') !== FIXTURE_SHA256)
    throw new Error('fixture_changed');
  const household = Household.parse(JSON.parse(bytes.toString('utf8')));
  if (household.id !== DEMO_ID || validateHousehold(household).length !== 0)
    throw new Error('fixture_invalid');
  return household;
}

/**
 * DB 全体が、最初の householdSet 一つだけを持つ架空の test 家庭一つの場合に限り、事象を足す。
 * 家庭一覧の確認と追加の間に別の家庭が作られないよう、家庭表を同じトランザクションで押さえる。
 * 既存の事象は書き換えず、二回目は拒否する。データベース移行はこの関数では行わない。
 */
export async function seedPushTest(db: Db, now: DateTime): Promise<void> {
  const household = demoHousehold();
  const local = formatDateTime(toEpochMinutes(now), household.timeZone);
  const hour = Number(local.slice(11, 13));
  // 夜間の試験通知で家族を起こさない。夜間規則そのものは別の試験で確かめる。
  if (hour < 7 || hour >= 22) throw new Error('outside_test_hours');
  const deadline = formatDateTime(toEpochMinutes(local) + 90, household.timeZone);
  const written = `架空の練習用の紙を${deadline}までに提出してください。`;
  const source = {
    id: SOURCE_ID,
    version: 1,
    receivedAt: local,
    sender: 'school' as const,
    language: 'ja' as const,
    medium: 'text' as const,
    title: '通知の練習（架空）',
    sentences: splitSentences(written, SOURCE_ID),
  };
  const output = {
    sourceId: SOURCE_ID,
    unknowns: [],
    conditions: [],
    irrelevantSentenceIds: [],
    ambiguities: [],
    items: [
      {
        id: ITEM_ID,
        sourceId: SOURCE_ID,
        sentenceIds: [`${SOURCE_ID}#1`],
        kind: 'submission' as const,
        written,
        interpretation: { what: '練習用の紙（架空）', deadline },
        evidence: 'stated' as const,
        effects: [],
      },
    ],
  };
  await db.transaction(async (tx) => {
    await tx.execute(sql`LOCK TABLE households IN SHARE ROW EXCLUSIVE MODE`);
    const rows = await tx.select({ id: households.id, kind: households.kind }).from(households);
    if (rows.length !== 1 || rows[0]?.id !== DEMO_ID || rows[0]?.kind !== 'test')
      throw new Error('not_dedicated_test_database');
    const subscriptions = await tx
      .select({ memberId: pushSubscriptions.memberId, identityId: pushSubscriptions.identityId })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.householdId, DEMO_ID));
    await postgresStore(tx).withHousehold(DEMO_ID, (log) => {
      const previous = log.events();
      const initial = previous[0];
      if (
        previous.length !== 1 ||
        initial?.type !== 'householdSet' ||
        !isDeepStrictEqual(initial.household, household)
      )
        throw new Error('not_empty_demo_household');
      if (!subscriptions.some((s) => log.isBound?.(s.memberId, s.identityId)))
        throw new Error('no_active_subscription');
      log.append(
        [
          { type: 'noticeReceived', source },
          {
            type: 'modelOutputRecorded',
            call: 'extract',
            model: 'fixture',
            promptVersion: 't005-fixture',
            inputHash: createHash('sha256').update(written).digest('hex'),
            sourceId: SOURCE_ID,
            output,
          },
        ],
        'system',
        local,
      );
      const events = [...log.events()];
      const plan = computePlan(events, local);
      const intents = notificationIntents(plan, household, notificationHistory(events));
      const expected = household.members
        .filter((m) => m.kind === 'adult' && m.active)
        .map((m) => m.id);
      const actual = intents.filter(
        (i) => i.titleKey === 'notify.unowned' && i.subject.id === `task:submit:${ITEM_ID}`,
      );
      const gate = sendGate({
        household,
        plan,
        events,
        intents,
        batchEnds: log.batchEnds?.() ?? [],
      });
      if (
        verifyPlan({ household, plan, events }).issues.some((i) => i.kind === 'violation') ||
        actual.length !== expected.length ||
        expected.some((id) => !actual.some((i) => i.toMemberId === id)) ||
        gate.all ||
        actual.some((i) => gate.blocked.has(i.key))
      )
        throw new Error('fixture_gate_failed');
    });
  });
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('database_missing');
  // connect() は移行を実行するため使わない。対象の確認より前に DB を変更しない。
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await seedPushTest(drizzle(pool), nowIn('Asia/Tokyo'));
    console.log(
      '架空の通知試験の事象を追加しました。事業者への送信・端末での表示は別に確かめてください。',
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    // DB の接続文字列や例外本文をログに出さない。
    const reason =
      error instanceof Error && Object.hasOwn(ERRORS, error.message)
        ? ERRORS[error.message]
        : undefined;
    console.error(reason ?? '通知試験の準備に失敗しました。対象と設定を確かめてください。');
    process.exitCode = 1;
  });
}
