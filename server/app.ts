import { maxPresenterVideoMs } from '../shared/domain';
import { motionTemplate } from './volc-visual';
import Fastify from 'fastify';
import { loadImage } from '@napi-rs/canvas';
import { z } from 'zod';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { Database } from './database';
import { authenticate, hashPassword, verifyPassword, tokenHash } from './auth';
import { Billing, serializeJob } from './billing';
import { ObjectStore } from './objects';
import { modelCatalog, CloudProviders } from './providers';
import { probe } from '../desktop/media';
import type { Account, GenerationInput } from '../shared/types';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const inputSchema = z
  .object({
    kind: z.enum(['speech', 'lipsync', 'motion', 'avatar', 'clone', 'cutout', 'matte']),
    model: z.enum([
      'cosyvoice-v3.5-flash',
      'cosyvoice-v3.5-plus',
      'mediakit-lipsync',
      'mediakit-remove-image-background',
      'mediakit-matte-portrait-video',
      'dreamactor-2.0',
      'omnihuman-1.5',
    ]),
    text: z.string().max(5000).optional(),
    ssml: z.string().max(20000).optional(),
    voiceId: z.string().max(200).optional(),
    speed: z.number().min(0.5).max(2).optional(),
    audioAssetId: z.uuid().optional(),
    videoAssetId: z.uuid().optional(),
    imageAssetId: z.uuid().optional(),
    preset: z.enum(['explain', 'emphasize', 'nod', 'greet', 'close']).optional(),
    durationMs: z.number().int().positive().max(maxPresenterVideoMs).optional(),
    loop: z.boolean().optional(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export function createApp(db: Database, objects: ObjectStore, env: NodeJS.ProcessEnv = process.env) {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, requestTimeout: 120000 });
  const billing = new Billing(db);
  const limits = new Map<string, { count: number; reset: number }>();
  const account = (request: any) => authenticate(db, request.headers.authorization);
  app.setErrorHandler((error, _request, reply) => {
    const e = error as Error & { statusCode?: number; code?: string };
    reply.code(e.statusCode ?? 400).send({
      error: e instanceof z.ZodError ? '参数格式不正确' : e.message,
      code: e.code === 'QUOTE_EXPIRED' ? e.code : undefined,
    });
  });
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: 256 * 1024 ** 2 },
    (_req, body, done) => done(null, body),
  );
  app.get('/health', async () => ({ ok: true, service: 'mooc-studio', revision: 9, version: '0.1.0' }));
  app.post('/auth/login', async (request) => {
    const key = request.ip;
    const item = limits.get(key);
    const limit = item && item.reset > Date.now() ? item : { count: 0, reset: Date.now() + 60000 };
    limits.set(key, limit);
    if (++limit.count > 10)
      throw Object.assign(new Error('登录尝试过于频繁，请稍后再试'), { statusCode: 429 });
    const { email, password } = z
      .object({ email: z.email(), password: z.string().min(1).max(256) })
      .parse(request.body);
    const [user] = await db.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!user || !verifyPassword(password, user.password))
      throw Object.assign(new Error('邮箱或密码不正确'), { statusCode: 401 });
    const token = randomBytes(32).toString('hex');
    await db.exec('INSERT INTO sessions VALUES($1,$2,$3)', [
      tokenHash(token),
      user.id,
      new Date(Date.now() + 30 * 86400000).toISOString(),
    ]);
    return {
      token,
      account: { id: user.id, email: user.email, role: user.role, organizationId: user.organization_id },
    };
  });
  app.post('/auth/logout', async (request) => {
    await account(request);
    await db.exec('DELETE FROM sessions WHERE hash=$1', [tokenHash(request.headers.authorization!.slice(7))]);
    return { ok: true };
  });
  app.get('/me', async (request) => account(request));
  app.get('/ledger', async (request) => {
    const user = await account(request);
    const { page } = z
      .object({ page: z.coerce.number().int().min(0).max(20000).default(0) })
      .parse(request.query);
    return db.query(
      'SELECT id,job_id,type,amount,created_at,description FROM ledger WHERE organization_id=$1 ORDER BY created_at,id LIMIT 500 OFFSET $2',
      [user.organizationId, page * 500],
    );
  });
  app.delete('/voices/:id', async (request) => {
    const user = await account(request);
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(request.params);
    const [voice] = await db.query('SELECT * FROM voices WHERE id=$1 AND user_id=$2', [id, user.id]);
    if (!voice) throw Object.assign(new Error('音色不存在或无权删除'), { statusCode: 404 });
    const jobs = await db.query(
      "SELECT input FROM jobs WHERE user_id=$1 AND status IN ('queued','running','unknown')",
      [user.id],
    );
    if (jobs.some((j) => JSON.parse(j.input).voiceId === id))
      throw new Error('仍有任务使用此音色，请等待任务完成或先核查状态');
    await new CloudProviders(objects, env).deleteVoice(voice.provider_id);
    await db.exec('DELETE FROM voices WHERE id=$1 AND user_id=$2', [id, user.id]);
    return { ok: true };
  });
  app.get('/voices', async (request) => {
    const user = await account(request);
    return db.query('SELECT id,model,created_at FROM voices WHERE user_id=$1 ORDER BY created_at DESC', [
      user.id,
    ]);
  });
  app.get('/voices/:id', async (request) => {
    const user = await account(request);
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(request.params);
    const [voice] = await db.query('SELECT id,model FROM voices WHERE id=$1 AND user_id=$2', [id, user.id]);
    if (!voice) throw Object.assign(new Error('音色已删除或不属于当前账号'), { statusCode: 404 });
    return voice;
  });
  app.get('/overview', async (request) => {
    const user = await account(request);
    const [wallet] = await db.query('SELECT * FROM wallets WHERE organization_id=$1', [user.organizationId]);
    const ledger = await db.query(
      'SELECT * FROM ledger WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100',
      [user.organizationId],
    );
    return {
      wallet: {
        availableMicros: Number(wallet.available),
        frozenMicros: Number(wallet.frozen),
        spentMicros: Number(wallet.spent),
      },
      ledger: ledger.map((l) => ({
        id: l.id,
        jobId: l.job_id,
        type: l.type,
        amountMicros: Number(l.amount),
        createdAt: l.created_at,
        description: l.description,
      })),
      models: modelCatalog(env),
    };
  });
  app.post('/admin/users', async (request) => {
    const user = await account(request);
    if (user.role !== 'admin') throw Object.assign(new Error('需要管理员权限'), { statusCode: 403 });
    const { email, password } = z
      .object({ email: z.email(), password: z.string().min(12).max(256) })
      .parse(request.body);
    await db.exec('INSERT INTO users VALUES($1,$2,$3,$4,$5)', [
      randomUUID(),
      email.toLowerCase(),
      hashPassword(password),
      user.organizationId,
      'author',
    ]);
    return { ok: true };
  });
  app.post('/admin/grants', async (request) => {
    const user = await account(request);
    const body = z
      .object({
        email: z.email(),
        amountMicros: z
          .number()
          .int()
          .positive()
          .max(1000000 * 100000),
        key: z.string().min(8).max(100),
      })
      .parse(request.body);
    await billing.grant(user, body.email, body.amountMicros, body.key);
    return { ok: true };
  });
  app.post('/assets', async (request) => {
    const user = await account(request);
    const body = z
      .object({
        name: z.string().min(1).max(240),
        mime: z.enum(['audio/wav', 'audio/mpeg', 'video/mp4', 'image/png', 'image/jpeg', 'image/webp']),
        size: z
          .number()
          .int()
          .positive()
          .max(256 * 1024 ** 2),
      })
      .parse(request.body);
    const [usage] = await db.query(
      "SELECT COALESCE(SUM(size),0) AS total FROM objects WHERE user_id=$1 AND status<>'deleted'",
      [user.id],
    );
    if (Number(usage.total) + body.size > 5 * 1024 ** 3)
      throw new Error('临时素材空间已超过 5GB，请等待清理或联系管理员');
    return { id: await objects.allocate(user.id, body.name, body.mime, body.size) };
  });
  app.put('/assets/:id/content', { bodyLimit: 256 * 1024 ** 2 }, async (request) => {
    const user = await account(request);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    if (!Buffer.isBuffer(request.body)) throw new Error('请上传二进制文件');
    await objects.put(user.id, id, request.body);
    return { ok: true };
  });
  app.get('/assets/:id/content', async (request, reply) => {
    const user = await account(request);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const row = await objects.owned(user.id, id);
    reply.type(row.mime).header('Cache-Control', 'private, no-store');
    return objects.read(id);
  });
  app.get('/files/:id', async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { expires, signature } = z
      .object({ expires: z.string(), signature: z.string() })
      .parse(request.query);
    if (!objects.validSignature(id, expires, signature))
      throw Object.assign(new Error('下载链接已失效'), { statusCode: 403 });
    const [row] = await db.query("SELECT * FROM objects WHERE id=$1 AND status='ready' AND expires_at>$2", [
      id,
      new Date().toISOString(),
    ]);
    if (!row) throw Object.assign(new Error('文件不存在'), { statusCode: 404 });
    reply.type(row.mime).header('Cache-Control', 'private, no-store');
    return objects.read(id);
  });
  app.post('/quotes', async (request) => {
    const user = await account(request);
    const { input: raw } = z.object({ input: inputSchema }).parse(request.body);
    const input: GenerationInput = raw;
    const model = modelCatalog(env).find((m) => m.id === input.model);
    if (
      !model?.available ||
      (model.kind !== input.kind && !(input.kind === 'clone' && model.kind === 'speech'))
    )
      throw new Error(model?.reason ?? '模型与任务不匹配');
    const media: Record<string, any> = {};
    for (const field of ['audioAssetId', 'videoAssetId', 'imageAssetId'] as const)
      if (input[field]) media[field] = await objects.owned(user.id, input[field]!);
    if (input.kind === 'speech') {
      if (!input.text?.trim()) throw new Error('讲稿不能为空');
      const [voice] = await db.query('SELECT * FROM voices WHERE id=$1 AND user_id=$2 AND model=$3', [
        input.voiceId ?? '',
        user.id,
        input.model,
      ]);
      if (!voice) throw new Error('请先为当前模型复刻本人音色');
      if (input.ssml) {
        if (XMLValidator.validate(input.ssml) !== true || /<!|<\?|https?:|src\s*=/i.test(input.ssml))
          throw new Error('SSML 不合法');
        for (const tag of input.ssml.matchAll(/<\/?([\w-]+)/g))
          if (!['speak', 'break', 'sub'].includes(tag[1])) throw new Error('SSML 包含未开放标签');
        // Bill the actual submitted text including alias text; clients cannot hide long text in SSML.
        input.text =
          input.ssml.replace(/<[^>]*>/g, '') +
          [...input.ssml.matchAll(/alias="([^"]*)"/g)].map((m) => m[1]).join('');
      }
    }
    if (['clone', 'lipsync', 'avatar'].includes(input.kind)) {
      if (!media.audioAssetId?.mime.startsWith('audio/')) throw new Error('缺少有效音频');
      const temp = path.join(objects.directory, `${randomUUID()}.wav`);
      writeFileSync(temp, await objects.read(input.audioAssetId!));
      try {
        const info = await probe(temp, env.FFPROBE_PATH);
        input.durationMs = info.durationMs;
        if (!input.durationMs || !info.hasAudio) throw new Error('音频没有有效声音轨道');
      } finally {
        unlinkSync(temp);
      }
      if (input.kind === 'clone' && (input.durationMs < 5000 || input.durationMs > 60000))
        throw new Error('音色参考应为 5–60 秒清晰录音，推荐 10–20 秒');
    }
    if (input.kind === 'lipsync' && media.videoAssetId?.mime !== 'video/mp4')
      throw new Error('口型驱动需要 MP4 人物视频');
    if (['motion', 'avatar', 'cutout'].includes(input.kind) && !media.imageAssetId?.mime.startsWith('image/'))
      throw new Error('需要人物照片');
    if (input.kind === 'cutout') {
      const image = await loadImage(await objects.read(input.imageAssetId!));
      input.imageFrame = { width: image.width, height: image.height };
    }
    if (input.kind === 'matte' || input.kind === 'lipsync') {
      if (media.videoAssetId?.mime !== 'video/mp4') throw new Error('需要 MP4 人物视频');
      const temp = path.join(objects.directory, randomUUID() + '.mp4');
      writeFileSync(temp, await objects.read(input.videoAssetId!));
      try {
        const info = await probe(temp, env.FFPROBE_PATH);
        if (!info.durationMs || !info.width || !info.height) throw new Error('无法读取人物视频的时长或尺寸。');
        input.videoFrame = { width: info.width, height: info.height };
        if (input.kind === 'matte') {
          if (Math.min(info.width, info.height) > 2160)
            throw new Error('原片超过当前抠像报价支持的 4K 档位，请选择其他素材。');
          input.durationMs = info.durationMs;
        }
      } finally {
        unlinkSync(temp);
      }
    }
    if (input.kind === 'motion') {
      if (!input.preset) throw new Error('请选择动作预设');
      if (input.videoAssetId) {
        if (media.videoAssetId?.mime !== 'video/mp4') throw new Error('请使用 MP4 动作参考');
        const temp = path.join(objects.directory, randomUUID() + '.mp4');
        writeFileSync(temp, await objects.read(input.videoAssetId));
        try {
          const info = await probe(temp, env.FFPROBE_PATH);
          if (
            !info.width ||
            !info.height ||
            Math.min(info.width, info.height) < 200 ||
            Math.max(info.width, info.height) > 2048 ||
            Math.min(info.width, info.height) > 1440 ||
            !info.durationMs ||
            info.durationMs < 6000 ||
            info.durationMs > 30000
          )
            throw new Error('动作参考模板须为 6–30 秒视频，画幅在 200×200 至 2048×1440 范围内。');
          input.durationMs = info.durationMs;
        } finally {
          unlinkSync(temp);
        }
      } else {
        if (env.VISUAL_PROVIDER !== 'gateway') motionTemplate(env, input.preset);
        input.durationMs = 6000;
      }
    }
    if (model.maxDurationMs && (input.durationMs ?? 0) > model.maxDurationMs)
      throw new Error('片段超过当前模型时长上限，请拆分讲稿');
    return billing.quote(user, input);
  });
  app.post('/jobs', async (request) => {
    const user = await account(request);
    const b = z
      .object({
        quoteId: z.uuid(),
        idempotencyKey: z.string().min(8).max(200),
        budgetMicros: z.number().int().nonnegative().max(1e12),
      })
      .parse(request.body);
    return billing.submit(user, b.quoteId, b.idempotencyKey, b.budgetMicros);
  });
  app.get('/jobs', async (request) => {
    const user = await account(request);
    return (
      await db.query(
        'SELECT jobs.*,objects.expires_at AS output_expires_at FROM jobs LEFT JOIN objects ON objects.id=jobs.output_asset_id WHERE jobs.user_id=$1 ORDER BY jobs.created_at DESC LIMIT 200',
        [user.id],
      )
    ).map(serializeJob);
  });
  app.get('/jobs/:id', async (request) => {
    const user = await account(request);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const [row] = await db.query(
      'SELECT jobs.*,objects.expires_at AS output_expires_at FROM jobs LEFT JOIN objects ON objects.id=jobs.output_asset_id WHERE jobs.id=$1 AND jobs.user_id=$2',
      [id, user.id],
    );
    if (!row) throw Object.assign(new Error('任务不存在'), { statusCode: 404 });
    return serializeJob(row);
  });
  app.post('/jobs/:id/cancel', async (request) => {
    const user = await account(request);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    await billing.cancel(user, id);
    return { ok: true };
  });
  app.post('/admin/jobs/:id/reconcile', async (request) => {
    const user = await account(request);
    if (user.role !== 'admin') throw Object.assign(new Error('需要管理员权限'), { statusCode: 403 });
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const b = z
      .object({ providerId: z.string().max(200).optional(), confirmedNotAccepted: z.boolean().optional() })
      .parse(request.body);
    const [job] = await db.query(
      "SELECT * FROM jobs WHERE id=$1 AND organization_id=$2 AND status='unknown'",
      [id, user.organizationId],
    );
    if (!job) throw new Error('任务不存在或无需核查');
    if (b.providerId)
      await db.exec("UPDATE jobs SET provider_id=$1,status='running',updated_at=$2,error=NULL WHERE id=$3", [
        b.providerId,
        new Date(0).toISOString(),
        id,
      ]);
    else if (b.confirmedNotAccepted)
      await billing.finish(id, false, undefined, '管理员确认上游未受理，额度已退回');
    else throw new Error('请填写供应商任务 ID 或确认未受理');
    return { ok: true };
  });
  return app;
}
