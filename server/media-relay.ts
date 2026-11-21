import { createHmac } from 'node:crypto';
import type { ObjectStore } from './objects';

interface RelayConfig {
  base: URL;
  token: string;
}

// The service URL can include a reverse-proxy mount path, e.g. https://media.example.org/mooc/.
export function mediaRelayConfig(env: NodeJS.ProcessEnv): RelayConfig | undefined {
  if (!env.MEDIA_RELAY_URL && !env.MEDIA_RELAY_TOKEN) return;
  let base: URL | undefined;
  try {
    base = new URL(env.MEDIA_RELAY_URL ?? '');
  } catch {
    /* Report the relevant setting without echoing credentials or URLs. */
  }
  if (
    !base ||
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    /^(localhost$|.*\.localhost$|127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]$)/i.test(
      base.hostname,
    )
  )
    throw new Error('请在后台 .env 填写模型可访问的公网 HTTPS MEDIA_RELAY_URL。');
  const token = env.MEDIA_RELAY_TOKEN;
  if (!token || !/^[\x21-\x7e]{32,}$/.test(token))
    throw new Error(
      '请在后台 .env 填写与中转服务器一致的 MEDIA_RELAY_TOKEN（至少 32 个非空白 ASCII 字符）。',
    );
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return { base, token };
}

export async function relayMotionAsset(
  relay: RelayConfig,
  objects: ObjectStore,
  userId: string,
  id: string,
  role: 'image' | 'video',
): Promise<string> {
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/.test(id))
    throw new Error('动作中转素材 ID 无效');
  const asset = await objects.owned(userId, id);
  if (
    role === 'image'
      ? !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mime)
      : asset.mime !== 'video/mp4'
  )
    throw new Error('动作中转只接受人物参考图和 MP4 动作模板。');
  const bytes = await objects.read(id);
  let response: Response;
  try {
    response = await fetch(new URL('v1/assets/' + id, relay.base), {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + relay.token,
        'Content-Type': asset.mime,
        'Content-Length': String(bytes.length),
      },
      body: new Uint8Array(bytes),
      redirect: 'error',
      signal: AbortSignal.timeout(180_000),
    });
  } catch {
    throw new Error('素材中转上传失败，请检查中转地址、HTTPS 证书及网络后重试。');
  }
  await response.body?.cancel();
  if (!response.ok) {
    const tip =
      response.status === 401 || response.status === 403
        ? '请核对中转令牌。'
        : response.status === 413 || response.status === 507
          ? '请检查文件大小及中转磁盘空间。'
          : '请检查中转服务后重试。';
    throw new Error(`素材中转上传失败（HTTP ${response.status}）。${tip}`);
  }
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const url = new URL('media/' + id, relay.base);
  url.searchParams.set('expires', String(expires));
  url.searchParams.set(
    'signature',
    createHmac('sha256', relay.token)
      .update(id + ':' + expires)
      .digest('hex'),
  );
  return url.href;
}
