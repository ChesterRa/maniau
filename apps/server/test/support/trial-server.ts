// 実 API と環境の鍵を使わない、独立したブラウザ試験のサーバー。
import { serve } from '@hono/node-server';
import { createApp } from '../../src/app';
import { trialReader } from './trial-reader';

const fake = trialReader();
const app = createApp(process.env.MANIAU_E2E_MODE === 'no-reader' ? {} : { reader: fake.reader });
app.get('/__e2e/reads', (c) => c.json(fake.calls));
serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 18797 }, () => {
  console.log('まにあう：http://localhost:18797（決まった架空文だけの試験用）');
});
