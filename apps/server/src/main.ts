// サーバーの入口。本番では、組み立てた画面（apps/web/dist）も同じサービスから返す。
// 家族の家庭は、置き場所の設定（DATABASE_URL と Access）がそろった時だけ開く。一部だけの設定は、
// デモに落とさずに止める（設定の誤りを、門の無いサーバーとして黙って動かさない）。知らせ（VAPID）も
// 同じく、全部そろった時だけ動かす。
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp, type FamilyBackend } from './app';
import { accessVerifier } from './auth/access';
import { connect } from './db/connect';
import { postgresStore } from './db/store';
import { messageGate, sendGate } from './gate';
import { invitationsFrom } from './members';
import { type Notifier, notifier } from './notifier';
import { type Vapid, webPushSender } from './push';
import { extractNotice, ReadingError } from './reading/extract';
import { PhotoTooLarge, transcribePhoto } from './reading/transcribe';
import { readUtterance } from './reading/utterance';

// 設定は環境変数だけから読む。手元の .env は、起動の命令（package.json の dev・start の
// --env-file-if-exists）が読む。入口そのものは .env を読まない（試験で起こす入口が、手元の鍵や DB の
// 設定を拾わないように）。本番は置き場所の設定から。

/** 全部あるか、全部無いか。一部だけなら止める。 */
function allOrNone<K extends string>(
  env: NodeJS.ProcessEnv,
  keys: readonly K[],
  what: string,
): Record<K, string> | undefined {
  const given = keys.filter((k) => env[k]);
  if (given.length === 0) return undefined;
  if (given.length !== keys.length) {
    throw new Error(`${what}の設定が足りない：${keys.filter((k) => !env[k]).join('、')}`);
  }
  return Object.fromEntries(keys.map((k) => [k, env[k] as string])) as Record<K, string>;
}

/** 家族の家庭の置き場所の設定（四つそろった時だけ開く）。 */
const FAMILY_KEYS = ['DATABASE_URL', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'APP_ORIGIN'] as const;

async function familyBackend(
  env: NodeJS.ProcessEnv,
): Promise<{ family: FamilyBackend; jobs?: Notifier } | undefined> {
  const config = allOrNone(env, FAMILY_KEYS, '家族の家庭');
  if (!config) return undefined;
  const vapid = allOrNone(
    env,
    ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'],
    '知らせ',
  );
  const { db } = await connect(config.DATABASE_URL);
  const store = postgresStore(db);
  const keys: Vapid | undefined = vapid && {
    publicKey: vapid.VAPID_PUBLIC_KEY,
    privateKey: vapid.VAPID_PRIVATE_KEY,
    subject: vapid.VAPID_SUBJECT,
  };
  const jobs =
    keys &&
    notifier({
      db,
      store,
      send: webPushSender(keys),
      gate: sendGate,
      messageGate,
      // 送った時のアプリの版（Railway は GitHub から組み立てた時のコミットを渡す）。
      appVersion: env.APP_VERSION ?? env.RAILWAY_GIT_COMMIT_SHA ?? 'unknown',
      report: (message) => console.error(message),
    });
  return {
    family: {
      db,
      store,
      verify: accessVerifier({
        teamDomain: config.ACCESS_TEAM_DOMAIN,
        audience: config.ACCESS_AUD,
      }),
      invitations: invitationsFrom(env.FAMILY_HOUSEHOLD_ID, env.ACCESS_INVITES),
      origin: new URL(config.APP_ORIGIN).origin,
      ...(keys && jobs ? { push: { publicKey: keys.publicKey, notifier: jobs } } : {}),
    },
    ...(jobs ? { jobs } : {}),
  };
}

// デモだけのサーバーを Access の後ろに置く時の入口（Access のチームと、デモのアプリの AUD）。二つそろえば、
// デモの API も要求ごとにトークンを確かめる（一つだけなら止める）。家族の家庭の設定と同じサーバーには
// 置かない（どちらの門で守るかを曖昧にしない）。家族の家庭の DB につなぐ前に確かめる。
const demoGate = allOrNone(
  process.env,
  ['DEMO_ACCESS_TEAM_DOMAIN', 'DEMO_ACCESS_AUD'],
  'デモの入口',
);
if (demoGate && FAMILY_KEYS.some((k) => process.env[k])) {
  throw new Error('デモの入口（DEMO_ACCESS_*）と家族の家庭の設定は、同じサーバーで同時にしない');
}
const backend = await familyBackend(process.env);
const family = backend?.family;
// Claude の鍵があれば、デモにお知らせの文を入れて読める（使った量は種類と数だけ記録する）。
// 一回の読み取りは一回の呼び出しにする（SDK の自動の再試行を止める。§8）。画面が待つ 120 秒より
// 先に諦め、読めなかったと返す（届いたか分からない、にしない）。
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ maxRetries: 0, timeout: 110_000 })
  : undefined;
const reader = anthropic
  ? async (request: Parameters<typeof extractNotice>[1]) => {
      try {
        const result = await extractNotice(anthropic, request);
        console.log(
          `読み取り：${result.model} 入力 ${result.usage.input_tokens}・出力 ${result.usage.output_tokens} tokens`,
        );
        return result;
      } catch (error) {
        // 失敗した呼び出しの量は分からない（0 と記録しない）。
        const kind = error instanceof ReadingError ? error.reason : 'error';
        console.log(`読み取り：失敗（${kind}）。使った量は分からない`);
        throw error;
      }
    }
  : undefined;
// 一言の読み取りも、同じ鍵と同じ記録の仕方で。
const listener = anthropic
  ? async (context: Parameters<typeof readUtterance>[1]) => {
      try {
        const result = await readUtterance(anthropic, context);
        console.log(
          `一言：${result.model} 入力 ${result.usage.input_tokens}・出力 ${result.usage.output_tokens} tokens`,
        );
        return result;
      } catch (error) {
        const kind = error instanceof ReadingError ? error.reason : 'error';
        console.log(`一言：失敗（${kind}）。使った量は分からない`);
        throw error;
      }
    }
  : undefined;
// 写真・PDF の書き起こしも、同じ鍵と同じ記録の仕方で（写真は残さない）。
const transcriber = anthropic
  ? async (photo: Parameters<typeof transcribePhoto>[1]) => {
      try {
        const result = await transcribePhoto(anthropic, photo);
        console.log(
          `書き起こし：${result.model} 入力 ${result.usage.input_tokens}・出力 ${result.usage.output_tokens} tokens`,
        );
        return result;
      } catch (error) {
        if (error instanceof PhotoTooLarge) {
          console.log(`書き起こし：入力が多すぎる（${error.inputTokens} tokens）。呼ばなかった`);
          throw error;
        }
        const kind = error instanceof ReadingError ? error.reason : 'error';
        console.log(`書き起こし：失敗（${kind}）。使った量は分からない`);
        throw error;
      }
    }
  : undefined;
// 家族の家庭を出すサーバーでは、デモの読み取りは開かない。家族の読み取りは身元を確かめた口で行う。
const app = createApp({
  ...(family ? { family } : {}),
  ...(demoGate
    ? {
        demoAccess: accessVerifier({
          teamDomain: demoGate.DEMO_ACCESS_TEAM_DOMAIN,
          audience: demoGate.DEMO_ACCESS_AUD,
        }),
      }
    : {}),
  ...(reader ? { reader } : {}),
  ...(listener ? { listener } : {}),
  ...(transcriber ? { transcriber } : {}),
});
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
app.use('/*', serveStatic({ root: webDist }));
app.get('/*', serveStatic({ root: webDist, path: 'index.html' }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  const mode = `${family ? `家族の家庭とデモ、知らせ${backend?.jobs ? 'あり' : 'なし'}` : `デモだけ${demoGate ? '（入口で身元を確かめる）' : ''}`}、読み取り${reader ? 'あり' : 'なし'}`;
  console.log(`まにあう：http://localhost:${info.port}（${mode}）`);
  backend?.jobs?.start();
});
