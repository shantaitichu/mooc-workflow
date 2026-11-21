import { createHash, createHmac } from 'node:crypto';
import { mediaRelayConfig } from './media-relay';
import type { GenerationInput, MotionPreset } from '../shared/types';
import { UncertainSubmission } from './provider-errors';

const host = 'visual.volcengineapi.com';
const reqKeys = {
  motion: 'jimeng_dreamactor_m20_gen_video',
  avatar: 'jimeng_realman_avatar_picture_omni_v15',
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const hmac = (key: string | Buffer, value: string) => createHmac('sha256', key).update(value).digest();

/** Restricted JSON POST signer. Cross-checked against the official SDK's deterministic fixture. */
export function signedVisualRequest(
  action: string,
  payload: object,
  credentials: { accessKeyId: string; secretKey: string; sessionToken?: string },
  date = new Date(),
) {
  const body = JSON.stringify(payload),
    timestamp = date.toISOString().replace(/[:-]|\.\d{3}/g, ''),
    day = timestamp.slice(0, 8);
  const query = new URLSearchParams({ Action: action, Version: '2022-08-31' }).toString();
  const headers: Record<string, string> = { host, 'x-date': timestamp, 'x-content-sha256': hash(body) };
  if (credentials.sessionToken) headers['x-security-token'] = credentials.sessionToken;
  const names = Object.keys(headers).sort();
  const canonical = [
    'POST',
    '/',
    query,
    names.map((n) => `${n}:${headers[n]}`).join('\n') + '\n',
    names.join(';'),
    hash(body),
  ].join('\n');
  const scope = `${day}/cn-north-1/cv/request`;
  const key = hmac(hmac(hmac(hmac(credentials.secretKey, day), 'cn-north-1'), 'cv'), 'request');
  const signature = hmac(key, ['HMAC-SHA256', timestamp, scope, hash(canonical)].join('\n')).toString('hex');
  headers.Authorization = `HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  headers['Content-Type'] = 'application/json';
  return { url: `https://${host}/?${query}`, body, headers };
}

export function motionTemplate(env: NodeJS.ProcessEnv, preset: MotionPreset) {
  const value = env[`MOTION_TEMPLATE_${preset.toUpperCase()}_URL`];
  if (!value) throw new Error('此动作尚未配置可用的 6 秒参考视频');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('动作模板必须使用 HTTPS 地址');
  return url.href;
}
export function visualConfigurationIssue(env: NodeJS.ProcessEnv, useMotionRelay = false): string | undefined {
  if (env.VISUAL_PROVIDER === 'gateway') {
    if (!env.VISUAL_GATEWAY_URL?.startsWith('https://') || !env.VISUAL_GATEWAY_TOKEN)
      return '后台 .env 缺少 HTTPS VISUAL_GATEWAY_URL 或 VISUAL_GATEWAY_TOKEN。';
  } else if (!env.VOLC_ACCESS_KEY_ID || !env.VOLC_SECRET_ACCESS_KEY) {
    return '在后台 .env 填写火山视觉服务 VOLC_ACCESS_KEY_ID 和 VOLC_SECRET_ACCESS_KEY，然后重启后台。';
  }
  if (useMotionRelay) {
    try {
      if (mediaRelayConfig(env)) return;
    } catch (e) {
      return (e as Error).message;
    }
  }
  // A gateway needs to fetch the same signed image and driver URLs as the direct service.
  if (!env.S3_BUCKET) {
    let base: URL | undefined;
    try {
      base = new URL(env.PUBLIC_BASE_URL ?? '');
    } catch {
      /* The actionable configuration error is returned below. */
    }
    if (
      base?.protocol !== 'https:' ||
      base.username ||
      base.password ||
      /^(localhost$|.*\.localhost$|127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]$)/i.test(
        base.hostname,
      )
    ) {
      return (
        (useMotionRelay ? '可在后台 .env 配置服务器中转 MEDIA_RELAY_URL 和 MEDIA_RELAY_TOKEN。' : '') +
        '也可配置对象存储 S3_BUCKET 或公网 HTTPS 素材下载地址 PUBLIC_BASE_URL，然后重启后台。'
      );
    }
  }
}
export class VolcVisual {
  constructor(
    readonly env: NodeJS.ProcessEnv,
    readonly transport: typeof fetch = fetch,
  ) {}
  private async call(action: string, body: object) {
    if (!this.env.VOLC_ACCESS_KEY_ID || !this.env.VOLC_SECRET_ACCESS_KEY)
      throw new Error('尚未配置火山视觉服务 AK/SK');
    const request = signedVisualRequest(action, body, {
      accessKeyId: this.env.VOLC_ACCESS_KEY_ID,
      secretKey: this.env.VOLC_SECRET_ACCESS_KEY,
      sessionToken: this.env.VOLC_SESSION_TOKEN,
    });
    let response: Response;
    try {
      response = await this.transport(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(60000),
        redirect: 'error',
      });
    } catch {
      throw new UncertainSubmission('视觉服务连接中断，受理状态待核查');
    }
    if (response.status >= 500)
      throw new UncertainSubmission(`视觉服务暂时异常 (${response.status})，受理状态待核查`);
    let result: any;
    try {
      result = await response.json();
    } catch {
      throw new UncertainSubmission('视觉服务响应无法解析，受理状态待核查');
    }
    if (!response.ok || result.code !== 10000)
      throw new Error(`视觉模型拒绝请求 (${result.code ?? response.status})，请核查权限及素材要求`);
    return result.data;
  }
  async submit(input: GenerationInput, imageUrl: string, audioUrl?: string, driverUrl?: string) {
    const motion = input.kind === 'motion';
    const payload = motion
      ? {
          req_key: reqKeys.motion,
          image_urls: [imageUrl],
          video_url: driverUrl ?? motionTemplate(this.env, input.preset!),
          cut_result_first_second_switch: true,
        }
      : {
          req_key: reqKeys.avatar,
          image_url: imageUrl,
          audio_url: audioUrl,
          output_resolution: 1080,
          pe_fast_mode: false,
          prompt: '固定机位，正式授课，自然克制的动作，保持人物形象与服装一致。',
        };
    const data = await this.call(motion ? 'CVSync2AsyncSubmitTask' : 'CVSubmitTask', payload);
    if (!data?.task_id) throw new UncertainSubmission('视觉服务未返回任务 ID，需要人工核查受理情况');
    return String(data.task_id);
  }
  async poll(input: GenerationInput, id: string): Promise<{ pending: true } | { url: string }> {
    const motion = input.kind === 'motion';
    const data = await this.call(motion ? 'CVSync2AsyncGetResult' : 'CVGetResult', {
      req_key: motion ? reqKeys.motion : reqKeys.avatar,
      task_id: id,
    });
    if (['processing', 'in_queue', 'generating'].includes(data?.status)) return { pending: true };
    if (data?.status === 'done' && typeof data.video_url === 'string') return { url: data.video_url };
    if (['not_found', 'expired'].includes(data?.status))
      throw new Error('视觉任务不存在或结果已过期，请核查后决定是否重新生成');
    throw new Error('视觉任务未返回有效视频，不能作为成功结果交付');
  }
}
