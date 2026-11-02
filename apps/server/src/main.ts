// サーバーの入口。本番では、組み立てた画面（apps/web/dist）も同じサービスから返す。
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app';

const app = createApp();
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
app.use('/*', serveStatic({ root: webDist }));
app.get('/*', serveStatic({ root: webDist, path: 'index.html' }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`まにあう：http://localhost:${info.port}`);
});
