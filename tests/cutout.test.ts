import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { CloudProviders, modelCatalog } from '../server/providers';
import type { ObjectStore } from '../server/objects';
import { portraitModel, portraitPriceMicros, priceMicros } from '../shared/domain';
import { Production } from '../desktop/production';
import type { CloudClient } from '../desktop/cloud';
import { MediaEngine } from '../desktop/media';
import { WorkspaceStore } from '../desktop/store';
import type { GenerationInput } from '../shared/types';

const input: GenerationInput = {
  kind: 'cutout',
  model: portraitModel,
  imageAssetId: 'source',
  fingerprint: 'c'.repeat(64),
};
const local = { VOLC_MEDIAKIT_API_KEY: 'test', ENABLED_VERIFIED_MODELS: portraitModel };
function portrait() {
  const canvas = createCanvas(512, 640),
    ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 512, 640);
  gradient.addColorStop(0, '#b0cdc6');
  gradient.addColorStop(1, '#7199a0');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 512, 640);
  const ellipse = (x: number, y: number, rx: number, ry: number, color: string) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, 2 * Math.PI);
    ctx.fill();
  };
  ellipse(255, 636, 205, 193, '#344457');
  ctx.fillStyle = '#bd9178';
  ctx.fillRect(224, 370, 65, 140);
  ellipse(255, 275, 111, 149, '#493c36');
  ellipse(255, 300, 97, 131, '#e1b79d');
  ellipse(257, 206, 92, 43, '#493c36');
  for (const x of [218, 292]) {
    ellipse(x, 287, 13, 6, '#fff6ee');
    ellipse(x, 287, 5, 6, '#34312d');
  }
  ellipse(255, 329, 8, 5, '#c29278');
  ctx.beginPath();
  ctx.strokeStyle = '#a06061';
  ctx.lineWidth = 4;
  ctx.arc(256, 340, 22, 0.25, 2.85);
  ctx.stroke();
  return canvas.toBuffer('image/png');
}
test('MediaKit 人像场景返回 PNG，按张报价，未配置时不开放', async (t) => {
  const objects = {
    url: async (user: string, id: string) => {
      assert.equal(user, 'author');
      assert.equal(id, 'source');
      return 'https://fixture.test/source.png';
    },
  } as ObjectStore;
  const output = createCanvas(10, 10);
  output.getContext('2d').fillRect(2, 2, 6, 7);
  const bytes = output.toBuffer('image/png');
  const p = new CloudProviders(objects, { ...local, S3_BUCKET: 'test' }, async (url) => {
    assert.equal(url, 'https://output.volcvideo.com/cut.png');
    return bytes;
  });
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://mediakit.cn-beijing.volces.com/api/v1/tools-sync/remove-image-background');
    assert.deepEqual(JSON.parse(String(init.body)), {
      image_url: 'https://fixture.test/source.png',
      scene: 'human',
      output_format: 'png',
    });
    return Response.json({ success: true, result: { image_url: 'https://output.volcvideo.com/cut.png' } });
  });
  assert.equal(priceMicros(input), portraitPriceMicros);
  assert.ok(modelCatalog(local).find((m) => m.id === portraitModel)?.available);
  assert.equal(modelCatalog({}).find((m) => m.id === portraitModel)?.available, false);
  assert.deepEqual(await p.submit(input, 'author', 'request'), { bytes, mime: 'image/png' });
  await assert.rejects(p.submit({ ...input, imageFrame: { width: 96, height: 96 } }, 'author', 'quality'), /96×96.*10×10/);
  const empty = new CloudProviders(objects, { ...local, S3_BUCKET: 'test' }, async () =>
    createCanvas(10, 10).toBuffer('image/png'),
  );
  await assert.rejects(empty.submit(input, 'author', 'blank'), /未识别到人物/);
});
test('重新抠图使用原始照片，云服务失败保留上一次形象', async () => {
  mkdirSync('.data', { recursive: true });
  const dir = mkdtempSync(path.resolve('.data/cloud-portrait-'));
  const store = new WorkspaceStore(dir);
  try {
    const course = store.create('抠图'),
      file = path.join(dir, '原照.png');
    writeFileSync(file, portrait());
    const source = store.addAsset(course.id, file, 'image');
    store.mutate(course.id, (c) => {
      c.speaker.imageAssetId = c.speaker.originalPortraitId = source.id;
    });
    let fail = false;
    const cloud = {
      upload: async (file: string) => {
        assert.equal(file, store.assetPath(course.id, source.id));
        return 'source';
      },
      generate: async (i: GenerationInput) => {
        assert.equal(i.model, portraitModel);
        if (fail) throw Error('抠图失败');
        return { id: 'test', outputAssetId: 'png' };
      },
      download: async (_: string, out: string) =>
        writeFileSync(out, createCanvas(4, 4).toBuffer('image/png')),
    };
    const production = new Production(
      store,
      new MediaEngine(store),
      cloud as unknown as CloudClient,
      () => {},
    );
    const result = await production.cutPortrait(course.id, source.id);
    assert.notEqual(result, source.id);
    fail = true;
    await assert.rejects(production.cutPortrait(course.id, source.id), /抠图失败/);
    assert.equal(store.get(course.id).speaker.imageAssetId, result);
    assert.equal(store.get(course.id).speaker.originalPortraitId, source.id);
  } finally {
    store.close();
  }
});
// Explicitly opt in to one billed provider call with a synthetic illustration.
test(
  '真实 MediaKit 测试图保留前景并产生透明背景',
  { skip: process.env.MOOC_LIVE_CUTOUT !== '1', timeout: 450000 },
  async () => {
    process.loadEnvFile('.env');
    const key = process.env.VOLC_MEDIAKIT_API_KEY;
    if (!key) throw new Error('缺少 MediaKit 密钥');
    const bytes = readFileSync('.data/mediakit-portrait-check/astronaut.png');
    const objects = {
      owned: async () => ({ mime: 'image/png' }),
      read: async () => bytes,
    } as unknown as ObjectStore;
    const provider = new CloudProviders(objects, { VOLC_MEDIAKIT_API_KEY: key });
    let result = await provider.submit(input, 'fixture', 'fixture');
    if (result.pendingId) result = await provider.poll(input, result.pendingId);
    assert.equal(result.mime, 'image/png');
    assert.ok(result.bytes);
    const img = await loadImage(result.bytes);
    const canvas = createCanvas(img.width, img.height),
      ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, img.width, img.height).data;
    let clear = 0,
      solid = 0;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] === 0) clear++;
      if (pixels[i] === 255) solid++;
    }
    mkdirSync('.data/mediakit-portrait-check', { recursive: true });
    writeFileSync('.data/mediakit-portrait-check/source.png', bytes);
    writeFileSync('.data/mediakit-portrait-check/cutout.png', result.bytes);
    assert.ok(clear && solid, '结果须同时包含透明背景和不透明前景');
  },
);
