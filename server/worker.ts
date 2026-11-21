import { randomUUID } from 'node:crypto';
import type { Database } from './database';
import type { Billing } from './billing';
import type { ObjectStore } from './objects';
import { UncertainSubmission, type Provider, type ProviderResult } from './providers';
import type { GenerationInput } from '../shared/types';
export class Worker {
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(
    readonly db: Database,
    readonly billing: Billing,
    readonly objects: ObjectStore,
    readonly provider: Provider,
  ) {}
  async recover() {
    await this.db.exec(
      "UPDATE jobs SET status='unknown',error=$1 WHERE status='running' AND provider_id IS NULL",
      ['服务重启时任务处于提交阶段，需人工核查上游受理状态。'],
    );
  }
  start() {
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        /* next tick retries persisted polling, never submission */
      });
    }, 2000);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      // One worker per instance. PG advisory lock allows only one active scheduler across replicas.
      const job = await this.db.transaction(async (c) => {
        if (this.db.postgres) {
          const [lock] = await c.query('SELECT pg_try_advisory_xact_lock(6721903) AS acquired');
          if (!lock.acquired) return undefined;
        }
        const [j] = await c.query(
          "SELECT * FROM jobs WHERE status='queued' OR (status='running' AND provider_id IS NOT NULL) ORDER BY updated_at LIMIT 1" +
            (this.db.postgres ? ' FOR UPDATE SKIP LOCKED' : ''),
        );
        if (!j) return undefined;
        // Lease running polls via updated_at to avoid concurrent polling and duplicate downloads.
        if (j.status === 'running' && Date.now() - Date.parse(j.updated_at) < 4000) return undefined;
        await c.exec("UPDATE jobs SET status='running',updated_at=$1 WHERE id=$2", [
          new Date(Date.now() + 5 * 60000).toISOString(),
          j.id,
        ]);
        return j;
      });
      if (!job) return;
      const input: GenerationInput = JSON.parse(job.input);
      try {
        let result: ProviderResult;
        if (job.provider_id) result = await this.provider.poll(input, job.provider_id);
        else result = await this.provider.submit(input, job.user_id, job.id);
        if (input.kind === 'clone' && result.voiceId && !job.provider_id)
          result = { pendingId: result.voiceId };
        if (result.pendingId) {
          await this.db.exec('UPDATE jobs SET provider_id=$1,updated_at=$2 WHERE id=$3', [
            result.pendingId,
            new Date().toISOString(),
            job.id,
          ]);
          return;
        }
        if (result.voiceId) {
          await this.db.exec('INSERT INTO voices VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING', [
            result.voiceId,
            job.user_id,
            input.model,
            result.voiceId,
            new Date().toISOString(),
          ]);
          await this.billing.finish(job.id, true, { voiceId: result.voiceId });
        } else if (result.bytes && result.mime) {
          const assetId = await this.objects.saveOutput(job.user_id, result.bytes, result.mime);
          await this.billing.finish(job.id, true, { assetId });
        } else throw new Error('模型未返回可交付产物');
        for (const assetId of [input.audioAssetId, input.videoAssetId, input.imageAssetId].filter(Boolean))
          await this.db.exec("UPDATE objects SET expires_at=$1 WHERE id=$2 AND purpose='input'", [
            new Date(Date.now() + 86400000).toISOString(),
            assetId,
          ]);
      } catch (e) {
        if (e instanceof UncertainSubmission) {
          if (!job.provider_id)
            await this.db.exec("UPDATE jobs SET status='unknown',error=$1 WHERE id=$2", [e.message, job.id]);
          // Polling transport errors leave the job running; do not resubmit or refund a still-active vendor job.
        } else
          await this.billing.finish(
            job.id,
            false,
            undefined,
            e instanceof Error ? e.message.slice(0, 500) : '生成失败',
          );
      }
    } finally {
      this.busy = false;
    }
  }
}
