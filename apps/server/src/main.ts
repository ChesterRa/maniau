// サーバーの入口。本番では、組み立てた画面（apps/web/dist）も同じサービスから返す。
// 家族の家庭は、置き場所の設定（DATABASE_URL と Access）がそろった時だけ開く。一部だけの設定は、
// デモに落とさずに止める（設定の誤りを、門の無いサーバーとして黙って動かさない）。知らせ（VAPID）も
// 同じく、全部そろった時だけ動かす。
import { fileURLToPath } from 'node:url';
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

async function familyBackend(
  env: NodeJS.ProcessEnv,
): Promise<{ family: FamilyBackend; jobs?: Notifier } | undefined> {
  const config = allOrNone(
    env,
    ['DATABASE_URL', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'APP_ORIGIN'],
    '家族の家庭',
  );
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

const backend = await familyBackend(process.env);
const family = backend?.family;
const app = createApp(family ? { family } : {});
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
app.use('/*', serveStatic({ root: webDist }));
app.get('/*', serveStatic({ root: webDist, path: 'index.html' }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  const mode = family ? `家族の家庭とデモ、知らせ${backend?.jobs ? 'あり' : 'なし'}` : 'デモだけ';
  console.log(`まにあう：http://localhost:${info.port}（${mode}）`);
  backend?.jobs?.start();
});
