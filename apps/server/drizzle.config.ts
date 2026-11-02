// 表の定め（src/db/schema.ts）から、移行の SQL を drizzle/ に作る（pnpm db:generate）。DB にはつながない。
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
