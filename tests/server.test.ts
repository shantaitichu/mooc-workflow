import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from '../server/database';
import { bootstrap } from '../server/auth';
import { ObjectStore } from '../server/objects';
import { createApp } from '../server/app';
import { Billing } from '../server/billing';
import { Worker } from '../server/worker';
import { UncertainSubmission } from '../server/providers';
import type { Account } from '../shared/types';

test('HTTP 登录、作者权限、机构余额和素材隔离', async () => {
  mkdirSync('.data', { recursive: true });
  const dir = mkdtempSync(path.resolve('.data/api-'));
  const db = new Database(':memory:');
  await db.initialize();
  await bootstrap(db, 'admin@example.test', 'correct-passphrase-123');
  const objects = new ObjectStore(db, dir, 'http://127.0.0.1:8787', 'x'.repeat(32), {});
  const app = createApp(db, objects, {});
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/overview' })).statusCode, 401);
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@example.test', password: 'correct-passphrase-123' },
    });
    assert.equal(login.statusCode, 200);
    const admin = login.json();
    const headers = { authorization: `Bearer ${admin.token}` };
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/admin/users',
          headers,
          payload: { email: 'author@example.test', password: 'author-passphrase-123' },
        })
      ).statusCode,
      200,
    );
    const author = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'author@example.test', password: 'author-passphrase-123' },
      })
    ).json();
    const authorHeaders = { authorization: `Bearer ${author.token}` };
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/admin/grants',
          headers: authorHeaders,
          payload: { email: 'author@example.test', amountMicros: 1000000, key: 'test-grant-key' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/admin/grants',
          headers,
          payload: { email: 'author@example.test', amountMicros: 1000000, key: 'test-grant-key' },
        })
      ).statusCode,
      200,
    );
    const over = (await app.inject({ method: 'GET', url: '/overview', headers: authorHeaders })).json();
    assert.equal(over.wallet.availableMicros, 1000000);
    assert.ok(over.models.every((m: any) => !m.available));
    const allocated = (
      await app.inject({
        method: 'POST',
        url: '/assets',
        headers,
        payload: { name: 'test.wav', mime: 'audio/wav', size: 4 },
      })
    ).json();
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: `/assets/${allocated.id}/content`,
          headers: { ...headers, 'content-type': 'application/octet-stream' },
          payload: Buffer.from('test'),
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: `/assets/${allocated.id}/content`, headers: authorHeaders }))
        .statusCode,
      404,
    );
    const downloaded = await app.inject({ method: 'GET', url: `/assets/${allocated.id}/content`, headers });
    assert.equal(downloaded.body, 'test');
    const signed = new URL(await objects.url(admin.account.id, allocated.id));
    assert.equal((await app.inject({ method: 'GET', url: signed.pathname + signed.search })).statusCode, 200);
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/files/${allocated.id}?expires=${Date.now() + 1000}&signature=${'a'.repeat(64)}`,
        })
      ).statusCode,
      403,
    );
    await db.exec('UPDATE objects SET expires_at=$1 WHERE id=$2', [new Date(0).toISOString(), allocated.id]);
    await objects.cleanup();
    assert.equal(
      (await app.inject({ method: 'GET', url: `/assets/${allocated.id}/content`, headers })).statusCode,
      404,
    );
    await app.inject({ method: 'POST', url: '/auth/logout', headers, payload: {} });
    assert.equal((await app.inject({ method: 'GET', url: '/overview', headers })).statusCode, 401);
  } finally {
    await app.close();
    await db.close();
  }
});
test('不确定的上游提交不会自动重提或提前退还冻结额度', async () => {
  mkdirSync('.data', { recursive: true });
  const db = new Database(':memory:');
  await db.initialize();
  const org = randomUUID();
  const user: Account = { id: randomUUID(), email: 'x@test.local', organizationId: org, role: 'admin' };
  await db.exec('INSERT INTO wallets VALUES($1,$2,$3,$4)', [org, 2000000, 0, 0]);
  const billing = new Billing(db);
  const objects = new ObjectStore(
    db,
    mkdtempSync(path.resolve('.data/worker-')),
    'http://localhost',
    's'.repeat(32),
    {},
  );
  let submits = 0;
  const worker = new Worker(db, billing, objects, {
    submit: async () => {
      submits++;
      throw new UncertainSubmission('network timeout');
    },
    poll: async () => ({}),
  });
  try {
    const quote = await billing.quote(user, {
      kind: 'lipsync',
      model: 'mediakit-lipsync',
      durationMs: 60000,
      fingerprint: 'a'.repeat(64),
    });
    const job = await billing.submit(user, quote.id, 'uncertain-key', 1000000);
    await worker.tick();
    await worker.tick();
    assert.equal(submits, 1);
    assert.equal((await db.query('SELECT * FROM jobs WHERE id=$1', [job.id]))[0].status, 'unknown');
    assert.equal(Number((await db.query('SELECT * FROM wallets'))[0].frozen), 1000000);
  } finally {
    worker.stop();
    await db.close();
  }
});

test('自选衔接动作按上传模板真实时长报价', async () => {
  const { tmpdir } = await import('node:os');
  const { ffmpeg, ffprobe } = await import('./media-tools');
  const { run } = await import('../desktop/process');
  const dir = mkdtempSync(path.join(tmpdir(), 'mooc-motion-price-'));
  const db = new Database(':memory:');
  await db.initialize();
  await bootstrap(db, 'admin@example.test', 'motion-price-test-password');
  const objects = new ObjectStore(db, dir, 'https://assets.example.test', 's'.repeat(32), {});
  const app = createApp(db, objects, {
    FFPROBE_PATH: ffprobe,
    ENABLED_VERIFIED_MODELS: 'dreamactor-2.0',
    VOLC_ACCESS_KEY_ID: 'a',
    VOLC_SECRET_ACCESS_KEY: 'b',
    PUBLIC_BASE_URL: 'https://assets.example.test',
  });
  try {
    const login = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'admin@example.test', password: 'motion-price-test-password' },
      })
    ).json();
    const file = path.join(dir, 'driver.mp4');
    await run(ffmpeg, [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=s=320x240:r=25',
      '-t',
      '9.2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      file,
    ]);
    const video = readFileSync(file);
    const videoId = await objects.allocate(login.account.id, 'driver.mp4', 'video/mp4', video.length);
    await objects.put(login.account.id, videoId, video);
    const image = await objects.allocate(login.account.id, 'idle.png', 'image/png', 1);
    await objects.put(login.account.id, image, Buffer.from([1]));
    const quote = await app.inject({
      method: 'POST',
      url: '/quotes',
      headers: { authorization: 'Bearer ' + login.token },
      payload: {
        input: {
          model: 'dreamactor-2.0',
          kind: 'motion',
          preset: 'explain',
          durationMs: 6000,
          videoAssetId: videoId,
          imageAssetId: image,
          fingerprint: 'b'.repeat(64),
        },
      },
    });
    assert.equal(quote.statusCode, 200, quote.body);
    assert.equal(quote.json().input.durationMs, 9200);
    assert.equal(quote.json().costMicros, 4600000);
  } finally {
    await app.close();
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('人物视频报价按实际时长接受整五分钟并拒绝多出一帧的文件', async () => {
  const { tmpdir } = await import('node:os');
  const { run } = await import('../desktop/process');
  const { ffmpeg, ffprobe } = await import('./media-tools');
  const { matteModel } = await import('../shared/domain');
  const dir = mkdtempSync(path.join(tmpdir(), 'mooc-length-'));
  const db = new Database(':memory:');
  await db.initialize();
  await bootstrap(db, 'author@example.test', 'test-password-for-length');
  const objects = new ObjectStore(db, dir, 'http://127.0.0.1:8787', 's'.repeat(32), {});
  const app = createApp(db, objects, {
    ENABLED_VERIFIED_MODELS: matteModel,
    VOLC_MEDIAKIT_API_KEY: 'fixture',
    FFPROBE_PATH: ffprobe,
  });
  try {
    const login = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'author@example.test', password: 'test-password-for-length' },
      })
    ).json();
    for (const [duration, size] of [
      [300000, '32x32'],
      [300040, '32x32'],
      [240, '1920x1080'],
      [240, '1440x2560'],
      [240, '3840x2160'],
    ] as const) {
      const file = path.join(dir, duration + '-' + size + '.mp4');
      await run(ffmpeg, [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=s=' + size + ':r=25',
        '-t',
        String(duration / 1000),
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        file,
      ]);
      const bytes = readFileSync(file);
      const id = await objects.allocate(login.account.id, 'test.mp4', 'video/mp4', bytes.length);
      await objects.put(login.account.id, id, bytes);
      const response = await app.inject({
        method: 'POST',
        url: '/quotes',
        headers: { authorization: 'Bearer ' + login.token },
        payload: {
          input: {
            model: matteModel,
            kind: 'matte',
            durationMs: 300000,
            videoAssetId: id,
            fingerprint: 'a'.repeat(64),
          },
        },
      });
      if (duration === 300000) {
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().costMicros, 5000000);
      } else if (duration === 240) {
        assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(response.json().input.videoFrame, {
          width: +size.split('x')[0],
          height: +size.split('x')[1],
        });
        assert.equal(
          response.json().costMicros,
          size === '1920x1080' ? 6000 : size === '1440x2560' ? 12000 : 16000,
        );
      } else {
        assert.notEqual(response.statusCode, 200);
        assert.match(response.body, /时长上限/);
      }
    }
  } finally {
    await app.close();
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
