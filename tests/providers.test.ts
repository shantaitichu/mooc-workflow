import test from 'node:test';
import assert from 'node:assert/strict';
import { signedVisualRequest, VolcVisual } from '../server/volc-visual';
import { UncertainSubmission, modelCatalog, CloudProviders } from '../server/providers';
import type { ObjectStore } from '../server/objects';
import type { GenerationInput } from '../shared/types';

const input: GenerationInput = {
  kind: 'motion',
  model: 'dreamactor-2.0',
  preset: 'explain',
  fingerprint: 'a'.repeat(64),
  durationMs: 6000,
};
const env = {
  VOLC_ACCESS_KEY_ID: 'test-ak',
  VOLC_SECRET_ACCESS_KEY: 'test-sk',
  PUBLIC_BASE_URL: 'https://example.test',
  MOTION_TEMPLATE_EXPLAIN_URL: 'https://example.test/motion.mp4',
};

test('本机口型生成上传两份用户素材，再用文件 ID 提交一次；上传失败时不提交口型任务', async (t) => {
  const lipInput: GenerationInput = {
    kind: 'lipsync',
    model: 'mediakit-lipsync',
    videoAssetId: 'video',
    audioAssetId: 'audio',
    fingerprint: 'b'.repeat(64),
  };
  const local = {
    PUBLIC_BASE_URL: 'http://127.0.0.1:8787',
    VOLC_MEDIAKIT_API_KEY: 'test-key',
    ENABLED_VERIFIED_MODELS: 'mediakit-lipsync',
  };
  const objects = {
    owned: async (user: string, id: string) => {
      assert.equal(user, 'author');
      return { mime: id === 'video' ? 'video/mp4' : 'audio/wav' };
    },
    read: async (id: string) => Buffer.from(id),
  } as ObjectStore;
  const provider = new CloudProviders(objects, local);
  let slots = 0,
    jobs = 0;
  let rejectUpload = '';
  const files: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init: RequestInit) => {
    const target = new URL(url);
    const headers = new Headers(init.headers);
    if (init.method === 'PUT') {
      assert.equal(target.hostname, 'tob-upload-y.volcvod.com');
      assert.equal(headers.get('Authorization'), null);
      assert.equal(headers.get('x-signed-header'), 'expected');
      files.push(Buffer.from(init.body as Uint8Array).toString());
      if (rejectUpload === files.at(-1)) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
      return new Response(null, { status: 200 });
    }
    assert.equal(headers.get('Authorization'), 'Bearer test-key');
    if (target.pathname.endsWith('request-media-upload-url')) {
      return Response.json({
        success: true,
        result: {
          method: 'PUT',
          file_id: `mediakit://${++slots}`,
          upload_url: 'https://tob-upload-y.volcvod.com/object',
          upload_headers: [{ key: 'x-signed-header', value: 'expected' }],
        },
      });
    }
    assert.equal(target.pathname, '/api/v1/tools/lip-sync');
    assert.deepEqual(JSON.parse(String(init.body)), {
      video_url: 'mediakit://1',
      audio_url: 'mediakit://2',
      enable_video_loop: false,
    });
    jobs++;
    return Response.json({ task_id: 'local-upload-job' });
  });
  assert.equal(modelCatalog(local).find((m) => m.id === lipInput.model)?.available, true);
  assert.deepEqual(await provider.submit(lipInput, 'author', 'request'), { pendingId: 'local-upload-job' });
  assert.deepEqual(files, ['video', 'audio']);
  rejectUpload = 'video';
  await assert.rejects(provider.submit(lipInput, 'author', 'next'), /视频.*上传失败.*ECONNRESET/);
  rejectUpload = 'audio';
  await assert.rejects(provider.submit(lipInput, 'author', 'next'), /音频.*上传失败.*ECONNRESET/);
  assert.equal(jobs, 1);
});

test('火山请求签名与官方 SDK 1.36.2 固定向量一致', () => {
  const payload = {
    req_key: 'jimeng_dreamactor_m20_gen_video',
    image_urls: ['https://example.test/portrait.png'],
    video_url: 'https://example.test/motion.mp4',
    cut_result_first_second_switch: true,
  };
  const req = signedVisualRequest(
    'CVSync2AsyncSubmitTask',
    payload,
    { accessKeyId: 'test-ak', secretKey: 'test-sk' },
    new Date('2026-11-17T00:00:00Z'),
  );
  assert.equal(
    req.headers.Authorization,
    'HMAC-SHA256 Credential=test-ak/20261117/cn-north-1/cv/request, SignedHeaders=host;x-content-sha256;x-date, Signature=732d853ca6e0835add44c49378abbcb7225ef046e87e4c2b3d069facbca44184',
  );
  assert.notEqual(
    signedVisualRequest(
      'CVSubmitTask',
      payload,
      { accessKeyId: 'test-ak', secretKey: 'test-sk' },
      new Date('2026-11-17T00:00:00Z'),
    ).headers.Authorization,
    req.headers.Authorization,
  );
});
test('动作与图片数字人采用各自官方提交/查询协议', async () => {
  const requests: { action: string; body: any }[] = [];
  const transport: typeof fetch = async (url, init) => {
    requests.push({
      action: new URL(String(url)).searchParams.get('Action')!,
      body: JSON.parse(init!.body as string),
    });
    return Response.json({ code: 10000, data: { task_id: '123', status: 'generating' } });
  };
  const provider = new VolcVisual(env, transport);
  assert.equal(await provider.submit(input, 'https://example.test/portrait.png'), '123');
  await provider.poll(input, '123');
  const avatar = { ...input, kind: 'avatar' as const, model: 'omnihuman-1.5' as const };
  await provider.submit(avatar, 'https://example.test/portrait.png', 'https://example.test/voice.wav');
  await provider.poll(avatar, '456');
  assert.deepEqual(
    requests.map((r) => r.action),
    ['CVSync2AsyncSubmitTask', 'CVSync2AsyncGetResult', 'CVSubmitTask', 'CVGetResult'],
  );
  assert.equal(requests[0].body.video_url, env.MOTION_TEMPLATE_EXPLAIN_URL);
  assert.equal(requests[2].body.audio_url, 'https://example.test/voice.wav');
  assert.equal(requests[2].body.req_key, 'jimeng_realman_avatar_picture_omni_v15');
});
test('视觉接口异常、过期、缺少结果不能误判成功', async () => {
  await assert.rejects(
    new VolcVisual(env, async () => {
      throw new Error('timeout');
    }).submit(input, 'https://example.test/p.png'),
    UncertainSubmission,
  );
  await assert.rejects(
    new VolcVisual(env, async () => Response.json({ code: 10000, data: { status: 'expired' } })).poll(
      input,
      '123',
    ),
    /过期/,
  );
  await assert.rejects(
    new VolcVisual(env, async () => Response.json({ code: 10000, data: { status: 'done' } })).poll(
      input,
      '123',
    ),
    /有效视频/,
  );
  await assert.rejects(
    new VolcVisual(env, async () => Response.json({ code: 50215 })).submit(
      input,
      'https://example.test/p.png',
    ),
    /50215/,
  );
});
test('动作选段模型按凭据、媒体地址和启用状态展示具体缺项，无需配置动作预设', () => {
  const model = (e: NodeJS.ProcessEnv) => modelCatalog(e).find((m) => m.id === 'dreamactor-2.0')!;
  assert.match(model({}).reason!, /VOLC_ACCESS_KEY_ID/);
  assert.match(model(env).reason!, /ENABLED_VERIFIED_MODELS/);
  const local = {
    ...env,
    PUBLIC_BASE_URL: 'http://127.0.0.1:8787',
    ENABLED_VERIFIED_MODELS: 'dreamactor-2.0',
  };
  for (const base of [local.PUBLIC_BASE_URL, 'https://localhost:8787', 'https://192.168.1.1']) {
    const blocked = model({ ...local, PUBLIC_BASE_URL: base });
    assert.equal(blocked.available, false);
    assert.match(blocked.reason!, /S3_BUCKET/);
  }
  assert.equal(model({ ...local, S3_BUCKET: 'private' }).available, true);
  assert.equal(
    model({ ...local, PUBLIC_BASE_URL: env.PUBLIC_BASE_URL, MOTION_TEMPLATE_EXPLAIN_URL: '' }).available,
    true,
  );
  assert.match(
    model({
      ...local,
      VISUAL_PROVIDER: 'gateway',
      VISUAL_GATEWAY_URL: 'https://example.test',
      VISUAL_GATEWAY_TOKEN: 'demo',
    }).reason!,
    /PUBLIC_BASE_URL/,
  );
});
test('衔接任务传入当前待机图及自选动作模板，直连与网关轮询并下载相应结果', async (t) => {
  const requests: { url: string; body?: any }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined });
    if (url.includes('CVSync2AsyncSubmitTask')) return Response.json({ code: 10000, data: { task_id: '1' } });
    if (url.includes('CVSync2AsyncGetResult'))
      return Response.json({
        code: 10000,
        data: { status: 'done', video_url: 'https://result.volces.com/done.mp4' },
      });
    if (url.endsWith('/jobs')) return Response.json({ task_id: '2' });
    return Response.json({
      status: 'completed',
      result: { video_url: 'https://result.volces.com/done.mp4' },
    });
  });
  const objects = {
    url: async (user: string, id: string) => `https://cdn.example.test/${user}/${id}`,
  } as ObjectStore;
  const custom = { ...input, imageAssetId: 'idle.png', videoAssetId: 'clip.mp4', durationMs: 9200 };
  for (const mode of ['volcengine', 'gateway']) {
    const api = new CloudProviders(
      objects,
      {
        ...env,
        VISUAL_PROVIDER: mode,
        VISUAL_GATEWAY_URL: 'https://gateway.example.test',
        VISUAL_GATEWAY_TOKEN: 'test',
      },
      async (url, hosts) => {
        assert.equal(url, 'https://result.volces.com/done.mp4');
        assert.ok(hosts.includes('volces.com'));
        return Buffer.from('test');
      },
    );
    const job = await api.submit(custom, 'user', 'key');
    const sent = requests.at(-1)!.body;
    if (mode === 'volcengine') {
      assert.deepEqual(sent, {
        req_key: 'jimeng_dreamactor_m20_gen_video',
        image_urls: ['https://cdn.example.test/user/idle.png'],
        video_url: 'https://cdn.example.test/user/clip.mp4',
        cut_result_first_second_switch: true,
      });
      assert.equal(job.pendingId, 'volc:1');
    } else {
      assert.equal(sent.videoUrl, 'https://cdn.example.test/user/clip.mp4');
      assert.equal(sent.imageUrl, 'https://cdn.example.test/user/idle.png');
      assert.equal(sent.durationMs, 9200);
      assert.equal(job.pendingId, 'gateway:2');
    }
    const done = await api.poll(custom, job.pendingId!);
    assert.equal(done.mime, 'video/mp4');
    assert.equal(done.bytes?.toString(), 'test');
  }
});

test('视频抠像接收 12 位 ProRes 与透明 WebM，拒收不透明及全透明视频', async (t) => {
  const { run } = await import('../desktop/process'),
    { ffmpeg, ffprobe } = await import('./media-tools');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs'),
    { tmpdir } = await import('node:os'),
    { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'mooc-provider-fixture-'));
  try {
    const src = join(dir, 'alpha.mov'),
      bad = join(dir, 'opaque.mov');
    await run(ffmpeg, [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=64x64:d=0.8,format=rgba,pad=96:96:16:16:color=black@0,fade=t=in:s=5:n=2:alpha=1',
      '-c:v',
      'prores_ks',
      '-profile:v',
      '4',
      '-pix_fmt',
      'yuva444p10le',
      src,
    ]);
    await run(ffmpeg, [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=blue:s=96x96:d=0.8',
      '-c:v',
      'libx264',
      bad,
    ]);
    let file = src;
    const p = new CloudProviders(
      { url: async () => 'https://example.test/input.mp4' } as unknown as ObjectStore,
      {
        PUBLIC_BASE_URL: 'https://example.test',
        VOLC_MEDIAKIT_API_KEY: 'fake',
        FFPROBE_PATH: ffprobe,
        FFMPEG_PATH: ffmpeg,
      },
      async () => readFileSync(file),
    );
    t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      if (init.method === 'POST') {
        assert.match(url, /tools\/matte-portrait-video$/);
        assert.deepEqual(JSON.parse(init.body as string), {
          video_url: 'https://example.test/input.mp4',
          format: 'WEBM',
        });
        return Response.json({ task_id: 'job' });
      }
      assert.match(url, /\/tasks\/job$/);
      return Response.json({ status: 'completed', result: { video_url: 'https://example.test/out.mov' } });
    });
    const input: GenerationInput = {
      kind: 'matte',
      model: 'mediakit-matte-portrait-video',
      videoAssetId: 'source',
      durationMs: 800,
      fingerprint: 'a'.repeat(64),
    };
    assert.deepEqual(await p.submit(input, 'author', 'request'), { pendingId: 'job' });
    assert.equal((await p.poll(input, 'job')).mime, 'video/quicktime');
    for (const codec of ['libvpx', 'libvpx-vp9']) {
      file = join(dir, codec + '.webm');
      await run(ffmpeg, [
        '-v',
        'error',
        '-i',
        src,
        '-c:v',
        codec,
        '-auto-alt-ref',
        '0',
        '-pix_fmt',
        'yuva420p',
        file,
      ]);
      assert.equal((await p.poll(input, 'job')).mime, 'video/webm');
    }
    file = join(dir, 'empty.mov');
    await run(ffmpeg, [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=black@0:s=96x96:d=0.8,format=rgba',
      '-c:v',
      'qtrle',
      file,
    ]);
    await assert.rejects(() => p.poll(input, 'job'), /透明背景/);
    file = bad;
    await assert.rejects(() => p.poll(input, 'job'), /透明背景/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
