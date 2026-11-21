import path from 'node:path';
import { Database } from './database';
import { bootstrap } from './auth';
import { Billing } from './billing';
import { ObjectStore } from './objects';
import { CloudProviders } from './providers';
import { Worker } from './worker';
import { createApp } from './app';
try {
  process.loadEnvFile('.env');
} catch {}
const env = process.env;
const directory = path.resolve(env.CLOUD_DATA_DIR ?? '.data/cloud');
if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32)
  throw new Error('请设置至少 32 字符的 SESSION_SECRET。');
if (
  env.NODE_ENV === 'production' &&
  (!env.DATABASE_URL?.startsWith('postgres') || !env.PUBLIC_BASE_URL?.startsWith('https://'))
)
  throw new Error('生产部署需要 PostgreSQL 和 HTTPS PUBLIC_BASE_URL。');
const db = new Database(env.DATABASE_URL || path.join(directory, 'cloud.sqlite'));
await db.initialize();
await bootstrap(
  db,
  (env.BOOTSTRAP_ADMIN_EMAIL ?? 'admin@example.local').toLowerCase(),
  env.BOOTSTRAP_ADMIN_PASSWORD ?? '',
);
const objects = new ObjectStore(
  db,
  path.join(directory, 'objects'),
  env.PUBLIC_BASE_URL ?? 'http://127.0.0.1:8787',
  env.SESSION_SECRET,
);
const worker = new Worker(db, new Billing(db), objects, new CloudProviders(objects));
const app = createApp(db, objects);
await app.listen({ port: Number(env.PORT ?? 8787), host: env.HOST ?? '127.0.0.1' });
await worker.recover();
worker.start();
const cleanup = setInterval(() => {
  void objects.cleanup().catch(() => process.stderr.write('对象清理失败，将在下一周期重试\n'));
}, 3600000);
process.stdout.write(`慕课云端服务已启动，监听 ${env.HOST ?? '127.0.0.1'}:${env.PORT ?? 8787}\n`);
async function stop() {
  worker.stop();
  clearInterval(cleanup);
  await app.close();
  await db.close();
}
process.on('SIGINT', () => {
  void stop();
});
process.on('SIGTERM', () => {
  void stop();
});
