import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { CloudProviders, modelCatalog } from '../server/providers';
import type { ObjectStore } from '../server/objects';
import type { GenerationInput } from '../shared/types';

const env = {
  VOLC_ACCESS_KEY_ID: 'test',
  VOLC_SECRET_ACCESS_KEY: 'test',
  PUBLIC_BASE_URL: 'http://127.0.0.1:8787',
  MEDIA_RELAY_URL: 'https://media.example.test/mooc',
  MEDIA_RELAY_TOKEN: 'example-integration-test-token-32-plus',
  ENABLED_VERIFIED_MODELS: 'dreamactor-2.0,omnihuman-1.5',
};

test('动作中转仅启用已完整配置的 Dreamactor 路线', () => {
  function check(overrides: NodeJS.ProcessEnv, model = 'dreamactor-2.0') {
    return modelCatalog({ ...env, ...overrides }).find((m) => m.id === model)!;
  }
  assert.equal(check({}).available, true);
  assert.equal(check({}, 'omnihuman-1.5').available, false);
  for (const url of [
    '',
    'http://media.example.test',
    'https://localhost',
    'https://user@media.example.test',
    'https://media.example.test/?secret=x',
  ]) {
    assert.match(check({ MEDIA_RELAY_URL: url }).reason!, /MEDIA_RELAY_URL/);
  }
  assert.match(check({ MEDIA_RELAY_TOKEN: '' }).reason!, /MEDIA_RELAY_TOKEN/);
});

test('动作提交只中转所属图和视频，返回一小时签名且不转发令牌；失败时不调用模型', async (t) => {
  const imageId = randomUUID(),
    videoId = randomUUID(),
    audioId = randomUUID();
  const order: string[] = [],
    checked: string[] = [];
  const objects = {
    async owned(user: string, id: string) {
      if (user !== 'owner') throw Error('素材不存在');
      checked.push(id);
      return { mime: id === imageId ? 'image/png' : 'video/mp4' };
    },
    async read(id: string) {
      assert.equal(checked.at(-1), id);
      return Buffer.from(id);
    },
    async url() {
      assert.fail('本机 URL 不能发给动作模型');
    },
  } as unknown as ObjectStore;
  const provider = new CloudProviders(objects, env);
  const input: GenerationInput = {
    kind: 'motion',
    model: 'dreamactor-2.0',
    preset: 'explain',
    imageAssetId: imageId,
    videoAssetId: videoId,
    audioAssetId: audioId,
    fingerprint: 'b'.repeat(64),
    durationMs: 6000,
  };
  let fail = false;
  t.mock.method(globalThis, 'fetch', async (url: URL | string, init: RequestInit) => {
    const target = new URL(url);
    const headers = new Headers(init.headers);
    if (target.hostname === 'media.example.test') {
      const id = target.pathname.split('/').at(-1)!;
      assert.equal(target.pathname, '/mooc/v1/assets/' + id);
      assert.equal(init.method, 'PUT');
      assert.equal(init.redirect, 'error');
      assert.equal(headers.get('Authorization'), 'Bearer ' + env.MEDIA_RELAY_TOKEN);
      assert.equal(headers.get('Content-Type'), id === imageId ? 'image/png' : 'video/mp4');
      const bytes = Buffer.from(init.body as Uint8Array);
      assert.equal(bytes.toString(), id);
      assert.equal(headers.get('Content-Length'), String(bytes.length));
      order.push(id);
      return new Response(null, { status: fail ? 507 : 201 });
    }
    assert.equal(target.hostname, 'visual.volcengineapi.com');
    assert.ok(!JSON.stringify(init).includes(env.MEDIA_RELAY_TOKEN));
    const body = JSON.parse(String(init.body));
    for (const [u, id] of [
      [body.image_urls[0], imageId],
      [body.video_url, videoId],
    ]) {
      const link = new URL(u);
      assert.equal(link.origin + link.pathname, env.MEDIA_RELAY_URL + '/media/' + id);
      const exp = link.searchParams.get('expires');
      assert.ok(Math.abs(Number(exp) - Date.now() / 1000 - 3600) < 2);
      assert.equal(
        link.searchParams.get('signature'),
        createHmac('sha256', env.MEDIA_RELAY_TOKEN)
          .update(id + ':' + exp)
          .digest('hex'),
      );
    }
    order.push('submit');
    return Response.json({ code: 10000, data: { task_id: '1' } });
  });
  assert.equal((await provider.submit(input, 'owner', 'req')).pendingId, 'volc:1');
  assert.deepEqual(order, [imageId, videoId, 'submit']);
  assert.deepEqual(checked, [imageId, videoId]);
  order.length = 0;
  await assert.rejects(() => provider.submit(input, 'other', 'req2'), /素材不存在/);
  assert.equal(order.length, 0);
  fail = true;
  await assert.rejects(() => provider.submit(input, 'owner', 'req3'), /507/);
  assert.deepEqual(order, [imageId]);
});
