import { createHmac, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Database } from './database';
export class ObjectStore {
  private s3?: S3Client;
  private bucket?: string;
  constructor(
    readonly db: Database,
    readonly directory: string,
    readonly publicUrl: string,
    readonly secret: string,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    mkdirSync(directory, { recursive: true });
    this.bucket = env.S3_BUCKET;
    if (this.bucket)
      this.s3 = new S3Client({
        region: env.S3_REGION ?? 'cn-beijing',
        endpoint: env.S3_ENDPOINT || undefined,
        forcePathStyle: true,
        credentials:
          env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
            ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
            : undefined,
      });
  }
  file(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效的素材 ID');
    return path.join(this.directory, id);
  }
  async allocate(userId: string, name: string, mime: string, size: number, purpose = 'input') {
    const id = randomUUID();
    const expires = new Date(Date.now() + (purpose === 'output' ? 7 : 1) * 86400000).toISOString();
    await this.db.exec(
      'INSERT INTO objects(id,user_id,name,mime,size,status,created_at,expires_at,purpose) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, userId, name, mime, size, 'pending', new Date().toISOString(), expires, purpose],
    );
    return id;
  }
  async owned(userId: string, id: string, ready = true): Promise<any> {
    const [row] = await this.db.query('SELECT * FROM objects WHERE id=$1 AND user_id=$2', [id, userId]);
    if (!row || (ready && row.status !== 'ready') || row.expires_at < new Date().toISOString())
      throw Object.assign(new Error('素材不存在或已过期'), { statusCode: 404 });
    return row;
  }
  async put(userId: string, id: string, data: Buffer) {
    const row = await this.owned(userId, id, false);
    if (row.status !== 'pending') throw new Error('素材已上传，不允许覆盖');
    if (Number(row.size) !== data.length) throw new Error('上传大小与声明不一致');
    if (this.s3)
      await this.s3.send(
        new PutObjectCommand({ Bucket: this.bucket, Key: id, Body: data, ContentType: row.mime }),
      );
    else writeFileSync(this.file(id), data);
    await this.db.exec("UPDATE objects SET status='ready',sha256=$1 WHERE id=$2", [
      createHash('sha256').update(data).digest('hex'),
      id,
    ]);
  }
  async read(id: string): Promise<Buffer> {
    if (this.s3) {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: id }));
      return Buffer.from(await r.Body!.transformToByteArray());
    }
    return readFileSync(this.file(id));
  }
  async saveOutput(userId: string, data: Buffer, mime: string): Promise<string> {
    const id = await this.allocate(
      userId,
      mime.startsWith('audio')
        ? 'generated.wav'
        : mime === 'image/png'
          ? 'portrait.png'
          : mime === 'video/quicktime'
            ? 'presenter.mov'
            : mime === 'video/webm'
              ? 'presenter.webm'
              : 'generated.mp4',
      mime,
      data.length,
      'output',
    );
    await this.put(userId, id, data);
    return id;
  }
  async url(userId: string, id: string): Promise<string> {
    await this.owned(userId, id);
    if (this.s3)
      return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: id }), {
        expiresIn: 3600,
      });
    const exp = Date.now() + 3600000;
    const signature = createHmac('sha256', this.secret).update(`${id}:${exp}`).digest('hex');
    return `${this.publicUrl}/files/${id}?expires=${exp}&signature=${signature}`;
  }
  validSignature(id: string, expires: string, signature: string): boolean {
    if (
      !/^\d+$/.test(expires) ||
      +expires < Date.now() ||
      +expires > Date.now() + 3601000 ||
      !/^[a-f0-9]{64}$/.test(signature)
    )
      return false;
    const actual = createHmac('sha256', this.secret).update(`${id}:${expires}`).digest();
    return timingSafeEqual(actual, Buffer.from(signature, 'hex'));
  }
  async cleanup() {
    const rows = await this.db.query("SELECT * FROM objects WHERE expires_at<$1 AND status<>'deleted'", [
      new Date().toISOString(),
    ]);
    for (const row of rows) {
      const active = await this.db.query(
        "SELECT input FROM jobs WHERE user_id=$1 AND status IN ('queued','running','unknown')",
        [row.user_id],
      );
      if (active.some((j) => Object.values(JSON.parse(j.input)).includes(row.id))) continue;
      if (this.s3) await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: row.id }));
      else if (existsSync(this.file(row.id))) unlinkSync(this.file(row.id));
      await this.db.exec("UPDATE objects SET status='deleted' WHERE id=$1", [row.id]);
    }
  }
}
