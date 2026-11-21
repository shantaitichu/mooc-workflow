import { scryptSync, randomBytes, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import type { Database } from './database';
import type { Account } from '../shared/types';
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, value] = stored.split(':');
  if (!salt || !value) return false;
  const expected = Buffer.from(value, 'hex');
  const actual = scryptSync(password, salt, 64);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export async function bootstrap(db: Database, email: string, password: string) {
  if (!password || password.length < 12)
    throw new Error('BOOTSTRAP_ADMIN_PASSWORD 需至少 12 位。请通过服务端环境变量设置。');
  if ((await db.query('SELECT id FROM users WHERE email=$1', [email])).length) return;
  await db.transaction(async (c) => {
    const org = randomUUID();
    await c.exec('INSERT INTO wallets VALUES($1,$2,$3,$4)', [org, 0, 0, 0]);
    await c.exec('INSERT INTO users VALUES($1,$2,$3,$4,$5)', [
      randomUUID(),
      email,
      hashPassword(password),
      org,
      'admin',
    ]);
  });
}
export async function authenticate(db: Database, header?: string): Promise<Account> {
  if (!header?.startsWith('Bearer ')) throw Object.assign(new Error('请先登录'), { statusCode: 401 });
  const [row] = await db.query(
    `SELECT u.* FROM users u JOIN sessions s ON u.id=s.user_id WHERE s.hash=$1 AND s.expires_at>$2`,
    [tokenHash(header.slice(7)), new Date().toISOString()],
  );
  if (!row) throw Object.assign(new Error('登录已过期，请重新登录'), { statusCode: 401 });
  return { id: row.id, email: row.email, role: row.role, organizationId: row.organization_id };
}
