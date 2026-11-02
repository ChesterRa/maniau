// サーバーの入口。本番では、組み立てた画面（apps/web/dist）も同じサービスから返す。
// 家族の家庭は、置き場所の設定（DATABASE_URL と Access）がそろった時だけ開く。一部だけの設定は、
// デモに落とさずに止める（設定の誤りを、門の無いサーバーとして黙って動かさない）。
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp, type FamilyBackend } from './app';
import { accessVerifier } from './auth/access';
import { connect } from './db/connect';
import { postgresStore } from './db/store';
import { invitationsFrom } from './members';

async function familyBackend(env: NodeJS.ProcessEnv): Promise<FamilyBackend | undefined> {
  const keys = ['DATABASE_URL', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'APP_ORIGIN'] as const;
  const given = keys.filter((k) => env[k]);
  if (given.length === 0) return undefined;
  if (given.length !== keys.length) {
    const missing = keys.filter((k) => !env[k]).join('、');
    throw new Error(`家族の家庭の設定が足りない：${missing}`);
  }
  const { db } = await connect(env.DATABASE_URL as string);
  return {
    db,
    store: postgresStore(db),
    verify: accessVerifier({
      teamDomain: env.ACCESS_TEAM_DOMAIN as string,
      audience: env.ACCESS_AUD as string,
    }),
    invitations: invitationsFrom(env.FAMILY_HOUSEHOLD_ID, env.ACCESS_INVITES),
    origin: new URL(env.APP_ORIGIN as string).origin,
  };
}

const family = await familyBackend(process.env);
const app = createApp(family ? { family } : {});
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
app.use('/*', serveStatic({ root: webDist }));
app.get('/*', serveStatic({ root: webDist, path: 'index.html' }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(
    `まにあう：http://localhost:${info.port}（${family ? '家族の家庭とデモ' : 'デモだけ'}）`,
  );
});
