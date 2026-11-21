import { randomUUID } from 'node:crypto';
import type { Account, CloudJob, GenerationInput, Quote } from '../shared/types';
import { fingerprint, priceMicros } from '../shared/domain';
import type { Database, Connection } from './database';
const now = () => new Date().toISOString();
export const serializeJob = (row: any): CloudJob => {
  const input = JSON.parse(row.input);
  return {
    id: row.id,
    kind: input.kind,
    model: input.model,
    fingerprint: input.fingerprint,
    preset: input.preset,
    outputExpiresAt: row.output_expires_at || undefined,
    status: row.status,
    costMicros: Number(row.cost),
    createdAt: row.created_at,
    error: row.error || undefined,
    outputAssetId: row.output_asset_id || undefined,
    voiceId: row.voice_id || undefined,
    cancelRequested: Boolean(row.cancel_requested),
  };
};
export class Billing {
  constructor(readonly db: Database) {}
  async quote(account: Account, input: GenerationInput): Promise<Quote> {
    const quote = {
      id: randomUUID(),
      input,
      costMicros: priceMicros(input),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      pricingVersion: 'pilot-native-resolution-2026-11-20',
    };
    await this.db.exec('INSERT INTO quotes VALUES($1,$2,$3,$4,$5,$6)', [
      quote.id,
      account.id,
      JSON.stringify(input),
      quote.costMicros,
      quote.expiresAt,
      quote.pricingVersion,
    ]);
    return quote;
  }
  async submit(account: Account, quoteId: string, key: string, cap: number): Promise<CloudJob> {
    return this.db.transaction(async (c) => {
      await c.query(
        `SELECT * FROM wallets WHERE organization_id=$1${this.db.postgres ? ' FOR UPDATE' : ''}`,
        [account.organizationId],
      );
      const [old] = await c.query('SELECT * FROM jobs WHERE user_id=$1 AND idempotency_key=$2', [
        account.id,
        key,
      ]);
      if (old) {
        if (old.quote_id !== quoteId) throw new Error('幂等键已用于另一份报价');
        return serializeJob(old);
      }
      const [q] = await c.query('SELECT * FROM quotes WHERE id=$1 AND user_id=$2', [quoteId, account.id]);
      if (!q) throw Object.assign(new Error('报价不存在或已过期，尚未创建任务'), { code: 'QUOTE_EXPIRED' });
      const [prior] = await c.query('SELECT * FROM jobs WHERE quote_id=$1', [quoteId]);
      if (prior) return serializeJob(prior);
      if (q.expires_at < now())
        throw Object.assign(new Error('报价不存在或已过期，尚未创建任务'), { code: 'QUOTE_EXPIRED' });
      if (Number(q.cost) > cap) throw new Error('本次费用超过预算上限');
      const [wallet] = await c.query('SELECT * FROM wallets WHERE organization_id=$1', [
        account.organizationId,
      ]);
      if (!wallet || Number(wallet.available) < Number(q.cost)) throw new Error('机构可用额度不足');
      const id = randomUUID();
      const created = now();
      await c.exec('UPDATE wallets SET available=available-$1,frozen=frozen+$1 WHERE organization_id=$2', [
        q.cost,
        account.organizationId,
      ]);
      await c.exec(
        'INSERT INTO jobs(id,user_id,organization_id,idempotency_key,quote_id,input,status,cost,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)',
        [id, account.id, account.organizationId, key, quoteId, q.input, 'queued', q.cost, created],
      );
      await this.record(c, account, id, 'freeze', Number(q.cost), '生成任务冻结额度');
      return serializeJob((await c.query('SELECT * FROM jobs WHERE id=$1', [id]))[0]);
    });
  }
  async finish(
    jobId: string,
    success: boolean,
    output?: { assetId?: string; voiceId?: string },
    error?: string,
  ) {
    await this.db.transaction(async (c) => {
      const [job] = await c.query(`SELECT * FROM jobs WHERE id=$1${this.db.postgres ? ' FOR UPDATE' : ''}`, [
        jobId,
      ]);
      if (!job || ['succeeded', 'failed', 'cancelled'].includes(job.status)) return;
      await c.query(
        `SELECT * FROM wallets WHERE organization_id=$1${this.db.postgres ? ' FOR UPDATE' : ''}`,
        [job.organization_id],
      );
      await c.exec(
        success
          ? 'UPDATE wallets SET frozen=frozen-$1,spent=spent+$1 WHERE organization_id=$2'
          : 'UPDATE wallets SET frozen=frozen-$1,available=available+$1 WHERE organization_id=$2',
        [job.cost, job.organization_id],
      );
      await c.exec(
        'UPDATE jobs SET status=$1,output_asset_id=$2,voice_id=$3,error=$4,updated_at=$5 WHERE id=$6',
        [
          success ? 'succeeded' : 'failed',
          output?.assetId ?? null,
          output?.voiceId ?? null,
          error ?? null,
          now(),
          jobId,
        ],
      );
      await this.record(
        c,
        { id: job.user_id, organizationId: job.organization_id } as Account,
        jobId,
        success ? 'settle' : 'release',
        Number(job.cost),
        success ? '生成成功结算' : '技术失败退还冻结额度',
      );
    });
  }
  async cancel(account: Account, jobId: string) {
    await this.db.transaction(async (c) => {
      const [job] = await c.query(
        `SELECT * FROM jobs WHERE id=$1 AND user_id=$2${this.db.postgres ? ' FOR UPDATE' : ''}`,
        [jobId, account.id],
      );
      if (!job) throw new Error('任务不存在');
      if (job.status === 'queued') {
        await c.exec('UPDATE wallets SET frozen=frozen-$1,available=available+$1 WHERE organization_id=$2', [
          job.cost,
          job.organization_id,
        ]);
        await c.exec("UPDATE jobs SET status='cancelled',cancel_requested=1,updated_at=$1 WHERE id=$2", [
          now(),
          jobId,
        ]);
        await this.record(c, account, jobId, 'release', Number(job.cost), '取消尚未提交的任务');
      } else if (['running', 'unknown'].includes(job.status))
        await c.exec('UPDATE jobs SET cancel_requested=1 WHERE id=$1', [jobId]);
    });
  }
  async grant(admin: Account, email: string, amount: number, key: string) {
    if (admin.role !== 'admin') throw Object.assign(new Error('需要机构管理员权限'), { statusCode: 403 });
    await this.db.transaction(async (c) => {
      await c.query(
        `SELECT * FROM wallets WHERE organization_id=$1${this.db.postgres ? ' FOR UPDATE' : ''}`,
        [admin.organizationId],
      );
      const [target] = await c.query('SELECT * FROM users WHERE email=$1 AND organization_id=$2', [
        email,
        admin.organizationId,
      ]);
      if (!target) throw new Error('用户不属于当前机构');
      const grantKey = `${admin.organizationId}:${key}`;
      const [existing] = await c.query('SELECT * FROM grants WHERE key=$1', [grantKey]);
      if (existing) {
        if (Number(existing.amount) !== amount) throw new Error('该幂等键已用于其他金额');
        return;
      }
      await c.exec('INSERT INTO grants VALUES($1,$2,$3)', [grantKey, admin.organizationId, amount]);
      await c.exec('UPDATE wallets SET available=available+$1 WHERE organization_id=$2', [
        amount,
        admin.organizationId,
      ]);
      await this.record(c, admin, null, 'grant', amount, '机构管理员增加试点额度');
    });
  }
  private async record(
    c: Connection,
    user: Account,
    jobId: string | null,
    type: string,
    amount: number,
    description: string,
  ) {
    await c.exec('INSERT INTO ledger VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [
      randomUUID(),
      user.organizationId,
      user.id,
      jobId,
      type,
      amount,
      now(),
      description,
    ]);
  }
}
