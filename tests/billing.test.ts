import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Database } from '../server/database';
import { Billing } from '../server/billing';
import type { Account, GenerationInput } from '../shared/types';

async function setup() {
  const db = new Database(':memory:');
  await db.initialize();
  const user: Account = {
    id: randomUUID(),
    email: 'author@example.test',
    organizationId: randomUUID(),
    role: 'admin',
  };
  await db.exec('INSERT INTO users VALUES($1,$2,$3,$4,$5)', [
    user.id,
    user.email,
    'unused',
    user.organizationId,
    user.role,
  ]);
  await db.exec('INSERT INTO wallets VALUES($1,$2,$3,$4)', [user.organizationId, 10000000, 0, 0]);
  return { db, billing: new Billing(db), user };
}
const input: GenerationInput = {
  kind: 'lipsync',
  model: 'mediakit-lipsync',
  durationMs: 60000,
  fingerprint: 'a'.repeat(64),
};
test('并发重复提交与重复结算只记账一次', async () => {
  const { db, billing, user } = await setup();
  try {
    const quote = await billing.quote(user, input);
    const jobs = await Promise.all(
      Array.from({ length: 10 }, () => billing.submit(user, quote.id, 'same-request', 1000000)),
    );
    assert.equal(new Set(jobs.map((j) => j.id)).size, 1);
    await Promise.all(
      Array.from({ length: 10 }, () => billing.finish(jobs[0].id, true, { assetId: randomUUID() })),
    );
    const [wallet] = await db.query('SELECT * FROM wallets');
    assert.equal(Number(wallet.available), 9000000);
    assert.equal(Number(wallet.frozen), 0);
    assert.equal(Number(wallet.spent), 1000000);
    assert.equal((await db.query('SELECT * FROM ledger')).length, 2);
  } finally {
    await db.close();
  }
});
test('技术失败释放冻结额度，重复失败不会多退', async () => {
  const { db, billing, user } = await setup();
  try {
    const q = await billing.quote(user, input);
    const job = await billing.submit(user, q.id, 'failed-request', 1000000);
    await billing.finish(job.id, false, undefined, '供应商错误');
    await billing.finish(job.id, false);
    const [w] = await db.query('SELECT * FROM wallets');
    assert.equal(Number(w.available), 10000000);
    assert.equal(Number(w.frozen), 0);
    assert.equal(Number(w.spent), 0);
  } finally {
    await db.close();
  }
});
test('余额、预算和跨账号报价限制', async () => {
  const { db, billing, user } = await setup();
  try {
    const q = await billing.quote(user, input);
    await assert.rejects(() => billing.submit(user, q.id, 'budget-limit', 999999), /预算/);
    await assert.rejects(
      () => billing.submit({ ...user, id: randomUUID() }, q.id, 'other-user', 1000000),
      /报价/,
    );
    await db.exec('UPDATE wallets SET available=0');
    await assert.rejects(() => billing.submit(user, q.id, 'empty-wallet', 1000000), /不足/);
  } finally {
    await db.close();
  }
});
test('未提交任务取消退款，运行中任务仅记录取消请求', async () => {
  const { db, billing, user } = await setup();
  try {
    const q = await billing.quote(user, input);
    const first = await billing.submit(user, q.id, 'cancel-queued', 1000000);
    await billing.cancel(user, first.id);
    await billing.cancel(user, first.id);
    const q2 = await billing.quote(user, input);
    const second = await billing.submit(user, q2.id, 'cancel-running', 1000000);
    await db.exec("UPDATE jobs SET status='running' WHERE id=$1", [second.id]);
    await billing.cancel(user, second.id);
    const [w] = await db.query('SELECT * FROM wallets');
    assert.equal(Number(w.frozen), 1000000);
    await billing.finish(second.id, true);
    assert.equal(Number((await db.query('SELECT * FROM wallets'))[0].spent), 1000000);
  } finally {
    await db.close();
  }
});
test('同一报价不能通过不同幂等键重复收费', async () => {
  const { db, billing, user } = await setup();
  try {
    const q = await billing.quote(user, input);
    const a = await billing.submit(user, q.id, 'key-first', 1000000);
    const b = await billing.submit(user, q.id, 'key-second', 1000000);
    assert.equal(a.id, b.id);
    assert.equal(Number((await db.query('SELECT * FROM wallets'))[0].frozen), 1000000);
  } finally {
    await db.close();
  }
});
test('机构充值幂等且作者无权增加额度', async () => {
  const { db, billing, user } = await setup();
  try {
    await billing.grant(user, user.email, 5000000, 'grant-12345');
    await billing.grant(user, user.email, 5000000, 'grant-12345');
    assert.equal(Number((await db.query('SELECT * FROM wallets'))[0].available), 15000000);
    await assert.rejects(
      () => billing.grant({ ...user, role: 'author' }, user.email, 1000000, 'forbidden'),
      /管理员/,
    );
  } finally {
    await db.close();
  }
});
test('过期报价恢复已受理任务，未受理报价明确退回且不能跨用户恢复', async () => {
  const { db, billing, user } = await setup();
  try {
    const q = await billing.quote(user, input),
      job = await billing.submit(user, q.id, 'before-timeout', 1000000);
    await db.exec('UPDATE quotes SET expires_at=$1', [new Date(0).toISOString()]);
    assert.equal((await billing.submit(user, q.id, 'after-timeout', 1000000)).id, job.id);
    await assert.rejects(
      () => billing.submit({ ...user, id: randomUUID() }, q.id, 'cross-user', 1000000),
      /报价/,
    );
    const fresh = await billing.quote(user, input);
    await db.exec('UPDATE quotes SET expires_at=$1 WHERE id=$2', [new Date(0).toISOString(), fresh.id]);
    await assert.rejects(
      () => billing.submit(user, fresh.id, 'expired-unused', 1000000),
      (e: any) => e.code === 'QUOTE_EXPIRED',
    );
    assert.equal((await db.query('SELECT * FROM jobs')).length, 1);
  } finally {
    await db.close();
  }
});
