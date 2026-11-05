// 空から始める試用：見本の家族だけ・名前だけの家族で始め、例のお知らせを録った読み取りで足し、開き直した画面が
// 同じデモに戻る。画面が使う HTTP の入口だけを通す（エンジンや置き場所は直接呼ばない）。
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { View } from '../src/views';

const jsonHeaders = { 'content-type': 'application/json' };
type App = ReturnType<typeof createApp>;
interface Info {
  sessionId: string;
  trial?: 'sample' | 'own';
  household: { members: { id: string; kind: string; name: string }[]; places: unknown[] };
  example: { sourceId: string; title: string };
}

async function start(app: App, body: unknown): Promise<Response> {
  return app.request('/api/demo/sessions', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
}
async function started(app: App, body: unknown): Promise<Info> {
  const response = await start(app, body);
  expect(response.status).toBe(200);
  return (await response.json()) as Info;
}
async function getView(app: App, session: string, memberId: string): Promise<View> {
  const response = await app.request(`/api/demo/sessions/${session}/view?member=${memberId}`);
  expect(response.status).toBe(200);
  return (await response.json()) as View;
}
async function addExample(app: App, session: string, memberId: string) {
  return app.request(`/api/demo/sessions/${session}/example-notice`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ memberId }),
  });
}

describe('見本の家族で、空から始める', () => {
  it('お知らせ・出来事の無い家庭で始まり、例のお知らせを足すと、段 arrived と同じ計画になる', async () => {
    const app = createApp();
    const info = await started(app, { start: 'sample' });
    expect(info.trial).toBe('sample');
    expect(info.example.title).toBe('学習発表会のお知らせ');
    const empty = await getView(app, info.sessionId, 'b');
    expect(empty.sources).toEqual([]);
    expect(empty.items).toEqual([]);
    expect(empty.plan.requirements).toEqual([]);
    expect(empty.plan.arrangements).toEqual([]);
    expect(empty.plan.tasks).toEqual([]);

    const added = await addExample(app, info.sessionId, 'b');
    expect(added.status).toBe(200);
    const { view, added: first } = (await added.json()) as { view: View; added: boolean };
    expect(first).toBe(true);

    const arrived = await started(app, { stage: 'arrived' });
    const staged = await getView(app, arrived.sessionId, 'b');
    expect(view.plan).toEqual(staged.plan);
    expect(view.today).toEqual(staged.today);
  });

  it('押し直しても、例のお知らせを二度入れない', async () => {
    const app = createApp();
    const info = await started(app, { start: 'sample' });
    const once = (await (await addExample(app, info.sessionId, 'a')).json()) as { view: View };
    const again = await addExample(app, info.sessionId, 'a');
    expect(again.status).toBe(200);
    const twice = (await again.json()) as { view: View; added: boolean };
    expect(twice.added).toBe(false);
    expect(twice.view.plan).toEqual(once.view.plan);
  });
});

describe('名前だけの家族で、空から始める', () => {
  it('入れた名前の大人と子だけで、見本の成員・場所・ふだんの週を混ぜない', async () => {
    const app = createApp();
    const info = await started(app, { start: 'own', adults: ['大人A', '大人B'], child: '子H' });
    expect(info.trial).toBe('own');
    expect(info.household.members).toEqual([
      expect.objectContaining({ id: 'a1', kind: 'adult', name: '大人A' }),
      expect.objectContaining({ id: 'a2', kind: 'adult', name: '大人B' }),
      expect.objectContaining({ id: 'c1', kind: 'child', name: '子H' }),
    ]);
    expect(info.household.places).toEqual([]);
    const view = await getView(app, info.sessionId, 'a1');
    expect(view.household.routines).toEqual([]);
    expect(view.household.careOptions).toEqual([]);
    expect(view.sources).toEqual([]);
    expect(view.items).toEqual([]);
    expect(JSON.stringify(view)).not.toMatch(/健太|彩|陽菜/);
  });

  it('例のお知らせを足すと、お知らせの事項と問いが出る（見本の家族の名前は出ない）', async () => {
    const app = createApp();
    const info = await started(app, { start: 'own', adults: ['大人A'], child: '子H' });
    const response = await addExample(app, info.sessionId, 'a1');
    expect(response.status).toBe(200);
    const { view } = (await response.json()) as { view: View };
    expect(view.sources.map((s) => s.title)).toEqual(['学習発表会のお知らせ']);
    expect(view.items.length).toBeGreaterThan(0);
    expect(view.plan.questions.length).toBeGreaterThan(0);
    expect(JSON.stringify(view.plan)).not.toMatch(/健太|彩|陽菜/);
  });

  it('子どもでは例のお知らせを足せない', async () => {
    const app = createApp();
    const info = await started(app, { start: 'own', adults: ['大人A'], child: '子H' });
    expect((await addExample(app, info.sessionId, 'c1')).status).toBe(403);
  });

  it('名前の無い・長すぎる・制御文字の名前、大人三人、大人のいない・子のいない始まり、同じ名前は断る', async () => {
    const app = createApp();
    for (const body of [
      { start: 'own', adults: [], child: '子' },
      { start: 'own', adults: [''], child: '子' },
      { start: 'own', adults: ['   '], child: '子' },
      { start: 'own', adults: ['あ'.repeat(21)], child: '子' },
      { start: 'own', adults: ['大人\u0007A'], child: '子' },
      { start: 'own', adults: ['一', '二', '三'], child: '子' },
      { start: 'own', adults: ['大人A'] },
      { start: 'own', adults: ['大人A'], child: '' },
      { start: 'own', adults: ['同じ'], child: '同じ' },
      { start: 'own', adults: ['大人A', ' 大人A '], child: '子' },
      { start: 'other' },
      { stage: 'nope' },
    ]) {
      expect((await start(app, body)).status).toBe(400);
    }
  });
});

describe('開き直した画面が、同じデモに戻る', () => {
  it('同じ家族と試用の種類を返し、知らないデモには 404', async () => {
    const app = createApp();
    const info = await started(app, { start: 'own', adults: ['大人A'], child: '子H' });
    const again = await app.request(`/api/demo/sessions/${info.sessionId}`);
    expect(again.status).toBe(200);
    const back = (await again.json()) as Info;
    expect(back.sessionId).toBe(info.sessionId);
    expect(back.trial).toBe('own');
    expect(back.household.members.map((m) => m.name)).toEqual(['大人A', '子H']);
    expect((await app.request('/api/demo/sessions/no-such-session')).status).toBe(404);
    expect((await addExample(app, 'no-such-session', 'a1')).status).toBe(404);
  });
});
