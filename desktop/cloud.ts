import { safeStorage } from 'electron';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkspaceStore } from './store';
import type { Account, CloudJob, GenerationInput, Quote } from '../shared/types';
import { fingerprint } from '../shared/domain';
export class CloudClient {
  private accountValue?: Account;
  constructor(readonly store: WorkspaceStore) {}
  get account() {
    return this.accountValue;
  }
  private token(): string {
    const encrypted = this.store.secret(`session:${this.store.settings().cloudUrl}`);
    if (!encrypted || !safeStorage.isEncryptionAvailable()) throw new Error('请先在设置中登录云服务');
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  }
  async request<T>(route: string, body?: unknown, method?: string): Promise<T> {
    const base = this.store.settings().cloudUrl;
    const url = new URL(base);
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname))
      throw new Error('云服务必须使用 HTTPS，本机开发服务除外');
    const response = await fetch(`${base.replace(/\/$/, '')}${route}`, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: {
        'Content-Type': 'application/json',
        ...(route === '/auth/login' ? {} : { Authorization: `Bearer ${this.token()}` }),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    const result = (await response.json()) as any;
    if (!response.ok)
      throw Object.assign(new Error(result.error ?? `云服务返回 ${response.status}`), { code: result.code });
    return result;
  }
  async login(email: string, password: string): Promise<Account> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全凭据存储不可用');
    const result = await this.request<{ token: string; account: Account }>('/auth/login', {
      email,
      password,
    });
    this.store.setSecret(
      `session:${this.store.settings().cloudUrl}`,
      safeStorage.encryptString(result.token).toString('base64'),
    );
    return (this.accountValue = result.account);
  }
  async restore() {
    try {
      this.accountValue = await this.request<Account>('/me');
    } catch {
      this.accountValue = undefined;
    }
  }
  async logout() {
    try {
      await this.request('/auth/logout', {});
    } finally {
      this.store.setSecret(`session:${this.store.settings().cloudUrl}`, '');
      this.accountValue = undefined;
    }
  }
  async upload(file: string, role = '素材'): Promise<string> {
    try {
      return await this.uploadFile(file);
    } catch (error) {
      throw new Error(`向后台上传${role}失败 · ${error instanceof Error ? error.message : '连接失败'}`);
    }
  }
  private async uploadFile(file: string): Promise<string> {
    if (statSync(file).size > 256 * 1024 ** 2)
      throw new Error('原尺寸上传文件超过后台单文件 256 MiB 上限。请截短选段或拆页后提交。');
    const bytes = readFileSync(file);
    const ext = path.extname(file).toLowerCase();
    const mime: Record<string, string> = {
      '.wav': 'audio/wav',
      '.mp3': 'audio/mpeg',
      '.mp4': 'video/mp4',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
    };
    if (!mime[ext]) throw new Error('请先将素材转换为 WAV、MP4 或 PNG/JPG');
    const asset = await this.request<{ id: string }>('/assets', {
      name: path.basename(file),
      mime: mime[ext],
      size: bytes.length,
    });
    const response = await fetch(`${this.store.settings().cloudUrl}/assets/${asset.id}/content`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${this.token()}`, 'Content-Type': 'application/octet-stream' },
      body: bytes,
      signal: AbortSignal.timeout(180000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('素材上传失败，请检查网络和文件大小');
    return asset.id;
  }
  async download(assetId: string, target: string) {
    const response = await fetch(`${this.store.settings().cloudUrl}/assets/${assetId}/content`, {
      headers: { Authorization: `Bearer ${this.token()}` },
      signal: AbortSignal.timeout(180000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('生成文件下载失败或已过期，请重试下载');
    writeFileSync(target, Buffer.from(await response.arrayBuffer()));
  }
  async generate(
    input: GenerationInput,
    remaining: { micros: number },
    signal: AbortSignal,
    onStatus: (message: string) => void,
  ): Promise<CloudJob> {
    if (!this.accountValue) await this.restore();
    if (!this.accountValue) throw new Error('请先登录云服务');
    const cacheKey = fingerprint({
      user: this.accountValue.id,
      cloud: this.store.settings().cloudUrl,
      fingerprint: input.fingerprint,
      kind: input.kind,
      model: input.model,
    });
    let stored = this.store.remote(cacheKey);
    let job: CloudJob | undefined;
    if (stored && !stored.startsWith('pending:')) {
      job = await this.request<CloudJob>(`/jobs/${stored}`);
      if (['failed', 'cancelled'].includes(job.status)) {
        stored = undefined;
        job = undefined;
      }
    }
    if (!job) {
      let quoteId: string;
      let key: string;
      if (stored?.startsWith('pending:')) {
        [, quoteId, key] = stored.split(':');
      } else {
        const quote = await this.request<Quote>('/quotes', { input });
        if (quote.costMicros > remaining.micros)
          throw new Error('实际音频时长对应的费用超过剩余预算。已完成素材已保留，请增加预算后继续。');
        quoteId = quote.id;
        key = randomUUID();
        this.store.setRemote(cacheKey, `pending:${quoteId}:${key}`, fingerprint(input));
      }
      try {
        job = await this.request<CloudJob>('/jobs', {
          quoteId,
          idempotencyKey: key,
          budgetMicros: remaining.micros,
        });
      } catch (error) {
        if ((error as { code?: string }).code === 'QUOTE_EXPIRED') {
          this.store.setRemote(cacheKey, '', '');
          return this.generate(input, remaining, signal, onStatus);
        }
        throw error;
      }
      this.store.setRemote(cacheKey, job.id, fingerprint(input));
      remaining.micros -= job.costMicros;
    }
    while (!['succeeded', 'failed', 'cancelled', 'unknown'].includes(job.status)) {
      if (signal.aborted) {
        if (signal.reason !== 'shutdown') await this.request(`/jobs/${job.id}/cancel`, {});
        throw new Error('已停止后续生成；已受理的云任务可能继续完成。');
      }
      onStatus(job.status === 'queued' ? '云端排队中' : '云端正在生成，可在下次打开时恢复结果');
      await new Promise((r) => setTimeout(r, 1800));
      job = await this.request<CloudJob>(`/jobs/${job.id}`);
    }
    if (job.status !== 'succeeded')
      throw new Error(
        job.error ??
          (job.status === 'unknown'
            ? '上游受理状态待核查，请管理员核查后继续，系统不会重复扣费提交。'
            : '任务已取消'),
      );
    return job;
  }
}
