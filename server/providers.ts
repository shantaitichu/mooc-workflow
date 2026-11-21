import { probe } from '../desktop/media';
import { hasMatte } from '../desktop/actor-video';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { maxPresenterVideoMs, matteModel, portraitPriceMicros, portraitModel } from '../shared/domain';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { GenerationInput, ModelEntry } from '../shared/types';
import type { ObjectStore } from './objects';
import { visualConfigurationIssue, VolcVisual } from './volc-visual';
import { mediaRelayConfig, relayMotionAsset } from './media-relay';
import { UncertainSubmission } from './provider-errors';

export { UncertainSubmission } from './provider-errors';
class InvalidPortraitOutput extends Error {}
export interface ProviderResult {
  bytes?: Buffer;
  mime?: string;
  voiceId?: string;
  pendingId?: string;
}
export interface Provider {
  submit(input: GenerationInput, userId: string, requestId: string): Promise<ProviderResult>;
  poll(input: GenerationInput, providerId: string): Promise<ProviderResult>;
}
export function modelCatalog(env: NodeJS.ProcessEnv = process.env): ModelEntry[] {
  const verified = new Set((env.ENABLED_VERIFIED_MODELS ?? '').split(',').map((s) => s.trim()));
  const visualIssue = visualConfigurationIssue(env);
  const motionIssue = visualConfigurationIssue(env, true);
  const definitions: Array<ModelEntry & { configured: boolean }> = [
    ...['flash', 'plus'].map((tier) => ({
      id: `cosyvoice-v3.5-${tier}`,
      name: `CosyVoice 3.5 ${tier === 'flash' ? 'Flash' : 'Plus'}`,
      kind: 'speech' as const,
      available: false,
      configured: Boolean(env.DASHSCOPE_API_KEY && env.SFM_WORKSPACE_ID),
      unit: '万字符',
      priceMicros: tier === 'flash' ? 800000 : 1500000,
    })),
    {
      id: matteModel,
      name: 'MediaKit 视频人像抠图（按短边分档，以下为起价）',
      kind: 'matte',
      configured: !!env.VOLC_MEDIAKIT_API_KEY,
      available: false,
      unit: '分钟',
      priceMicros: 1000000,
      maxDurationMs: maxPresenterVideoMs,
    },
    {
      id: portraitModel,
      name: 'MediaKit 人像背景移除',
      kind: 'cutout',
      configured: Boolean(env.VOLC_MEDIAKIT_API_KEY),
      available: false,
      unit: '张',
      priceMicros: portraitPriceMicros,
    },
    {
      id: 'mediakit-lipsync',
      name: 'MediaKit 口型驱动',
      kind: 'lipsync',
      configured: Boolean(env.VOLC_MEDIAKIT_API_KEY),
      available: false,
      unit: '分钟',
      priceMicros: 1000000,
      maxDurationMs: maxPresenterVideoMs,
    },
    {
      id: 'dreamactor-2.0',
      name: 'Dreamactor 2.0 动作',
      kind: 'motion',
      configured: !motionIssue,
      reason: motionIssue,
      available: false,
      unit: '秒',
      priceMicros: 500000,
      maxDurationMs: 30000,
    },
    {
      id: 'omnihuman-1.5',
      name: 'OmniHuman 1.5',
      kind: 'avatar',
      configured: !visualIssue,
      reason: visualIssue,
      available: false,
      unit: '秒',
      priceMicros: 1000000,
      maxDurationMs: 30000,
    },
  ];
  return definitions.map(({ configured, ...m }) => ({
    ...m,
    available: configured && verified.has(m.id),
    reason: !configured
      ? (m.reason ?? '服务端尚未配置凭据或媒体地址')
      : !verified.has(m.id)
        ? `模型尚未启用。请在后台 .env 的 ENABLED_VERIFIED_MODELS 加入 ${m.id} 并重启后台。`
        : undefined,
  }));
}
async function jsonCall(url: string, token: string, body?: unknown): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(body ? 300000 : 30000),
      redirect: 'error',
    });
  } catch {
    throw new UncertainSubmission('服务连接中断，无法确认上游是否受理；保留任务等待核查，不自动重复提交。');
  }
  if (!response.ok) {
    if (response.status >= 500) throw new UncertainSubmission(`上游返回 ${response.status}，受理状态待核查`);
    throw new Error(`模型接口拒绝请求 (${response.status})，请检查配置及素材。`);
  }
  const data = (await response.json()) as any;
  if (data.success === false || data.code)
    throw new Error(`模型调用失败：${data.error?.code ?? data.code ?? 'unknown'}`);
  return data;
}
export async function downloadProviderOutput(url: string, allowedHosts: string[]): Promise<Buffer> {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    isIP(parsed.hostname) ||
    !allowedHosts.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))
  )
    throw new Error('供应商结果地址不在允许的 HTTPS 域名范围内');
  const records = await lookup(parsed.hostname, { all: true });
  if (
    records.some((r) =>
      /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1$|f[cd]|fe80|::ffff:)/i.test(
        r.address,
      ),
    )
  )
    throw new Error('拒绝访问内部结果地址');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error('下载模型结果失败');
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > 512 * 1024 ** 2) throw new Error('模型结果超过 512MB 限制');
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}
export class CloudProviders implements Provider {
  constructor(
    readonly objects: ObjectStore,
    readonly env: NodeJS.ProcessEnv = process.env,
    private readonly downloadOutput = downloadProviderOutput,
  ) {}
  private ttsBase() {
    if (!/^[\w-]+$/.test(this.env.SFM_WORKSPACE_ID ?? '')) throw new Error('SFM_WORKSPACE_ID 无效');
    return `https://${this.env.SFM_WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts`;
  }
  private async mediaKitInput(userId: string, id: string, role: string): Promise<string> {
    try {
      return await this.prepareMediaKitInput(userId, id);
    } catch (error) {
      const detail = error instanceof Error ? error.message : '连接失败';
      const code = (error as { cause?: { code?: unknown } })?.cause?.code;
      throw new Error(`火山 ${role}素材准备或上传失败 · ${detail}${typeof code === 'string' ? ' (' + code + ')' : ''}`);
    }
  }
  private async prepareMediaKitInput(userId: string, id: string): Promise<string> {
    if (this.env.S3_BUCKET || this.env.PUBLIC_BASE_URL?.startsWith('https://'))
      return this.objects.url(userId, id);

    const asset = await this.objects.owned(userId, id);
    let slot;
    try {
      const response = await jsonCall(
        'https://mediakit.cn-beijing.volces.com/api/v1/tools-sync/request-media-upload-url',
        this.env.VOLC_MEDIAKIT_API_KEY!,
        {},
      );
      slot = response.result;
    } catch (error) {
      if (error instanceof UncertainSubmission) throw new Error('申请火山素材上传地址失败，可重新制作样片。');
      throw error;
    }
    if (!slot?.file_id?.startsWith('mediakit://') || slot.method !== 'PUT')
      throw new Error('火山返回的素材上传凭证不完整');
    const target = new URL(slot.upload_url);
    if (
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      !/\.(volcvod|volces)\.com$/i.test(target.hostname)
    )
      throw new Error('火山素材上传地址无效');
    const headers = new Headers({ 'Content-Type': asset.mime });
    for (const { key, value } of slot.upload_headers ?? []) headers.set(key, value);
    const bytes = await this.objects.read(id);
    const upload = await fetch(target, {
      method: 'PUT',
      body: new Uint8Array(bytes),
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(300000),
    });
    if (!upload.ok) throw new Error(`火山素材上传失败 (HTTP ${upload.status})，可重新制作样片。`);
    return slot.file_id;
  }
  private async downloadVideoResult(url: string, hosts: string[]) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.downloadOutput(url, hosts);
      } catch (error) {
        const detail = error instanceof Error ? error.message : '连接失败';
        const network = error instanceof Error && (error.message === 'fetch failed' ||
          error.name === 'TimeoutError' || error.message === 'terminated' ||
          ['ECONNRESET','ETIMEDOUT','EAI_AGAIN'].includes(String((error as NodeJS.ErrnoException).code)));
        if (!network || attempt >= 3) throw new Error(`下载已生成的视频失败（第 ${attempt} 次） · ${detail}`);
        await new Promise(resolve => setTimeout(resolve, attempt * 500));
      }
    }
  }
  private async portraitOutput(url: string, expected?: GenerationInput['imageFrame']): Promise<ProviderResult> {
    const bytes = await this.downloadOutput(url, [
      'volcvideo.com',
      'volces.com',
      'byteimg.com',
      'ibytedtos.com',
      'volcvod.com',
      ...(this.env.VISUAL_OUTPUT_HOSTS ?? '').split(',').filter(Boolean),
    ]);
    if (
      bytes.length < 33 ||
      !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
      bytes.toString('ascii', 12, 16) !== 'IHDR'
    )
      throw new InvalidPortraitOutput('MediaKit 返回的文件不是 PNG');
    const width = bytes.readUInt32BE(16),
      height = bytes.readUInt32BE(20);
    if (!width || !height || Math.max(width, height) > 7680 || Math.min(width, height) > 4320)
      throw new InvalidPortraitOutput('MediaKit 抠图结果尺寸异常');
    if (expected && (width !== expected.width || height !== expected.height))
      throw new InvalidPortraitOutput(`照片抠图将 ${expected.width}×${expected.height} 返回为 ${width}×${height}，请检查原照。`);
    // Inspect a small alpha sample only. Preserve the original provider PNG verbatim.
    const ctx = createCanvas(128, 128).getContext('2d');
    ctx.drawImage(await loadImage(bytes), 0, 0, 128, 128);
    const pixels = ctx.getImageData(0, 0, 128, 128).data;
    let foreground = false,
      background = false;
    for (let i = 3; i < pixels.length; i += 4) {
      foreground ||= pixels[i] > 127;
      background ||= pixels[i] < 128;
      if (foreground && background) break;
    }
    if (!foreground) throw new InvalidPortraitOutput('MediaKit 未识别到人物，请换用清晰的真人照片。');
    if (!background) throw new InvalidPortraitOutput('MediaKit 返回的图片没有透明背景，请检查照片后重试。');
    return { bytes, mime: 'image/png' };
  }
  async deleteVoice(voiceId: string) {
    await jsonCall(`${this.ttsBase()}/customization`, this.env.DASHSCOPE_API_KEY!, {
      model: 'voice-enrollment',
      input: { action: 'delete_voice', voice_id: voiceId },
    });
  }
  async submit(input: GenerationInput, userId: string, requestId: string): Promise<ProviderResult> {
    if (input.kind === 'cutout') {
      const image_url = await this.mediaKitInput(userId, input.imageAssetId!, '图片');
      const response = await jsonCall(
        'https://mediakit.cn-beijing.volces.com/api/v1/tools-sync/remove-image-background',
        this.env.VOLC_MEDIAKIT_API_KEY!,
        { image_url, scene: 'human', output_format: 'png' },
      );
      if (response.result?.image_url) {
        try {
          return await this.portraitOutput(response.result.image_url, input.imageFrame);
        } catch (error) {
          if (error instanceof InvalidPortraitOutput) throw error;
          if (!response.task_id) throw new UncertainSubmission('抠图已受理，结果下载失败，请核查上游任务');
        }
      }
      if (response.task_id) return { pendingId: response.task_id };
      throw new UncertainSubmission('抠图响应缺少结果和任务 ID，请核查上游任务');
    }
    if (input.kind === 'clone') {
      const data = await this.objects.read(input.audioAssetId!);
      const result = await jsonCall(`${this.ttsBase()}/customization`, this.env.DASHSCOPE_API_KEY!, {
        model: 'voice-enrollment',
        input: {
          action: 'create_voice',
          target_model: input.model,
          prefix: 'mooc',
          audio: `data:audio/wav;base64,${data.toString('base64')}`,
          language_hints: ['zh'],
        },
      });
      if (!result.output?.voice_id) throw new UncertainSubmission('复刻响应缺少音色 ID，需服务端核查');
      return { voiceId: result.output.voice_id };
    }
    if (input.kind === 'speech') {
      const response = await jsonCall(`${this.ttsBase()}/SpeechSynthesizer`, this.env.DASHSCOPE_API_KEY!, {
        model: input.model,
        input: {
          text: input.ssml ?? input.text,
          voice: input.voiceId,
          format: 'wav',
          sample_rate: 48000,
          rate: input.speed ?? 1,
          enable_ssml: Boolean(input.ssml),
        },
      });
      const url = response.output?.audio?.url;
      if (!url) throw new UncertainSubmission('语音响应缺少文件地址，需服务端核查');
      // 百炼也可能返回 HTTP 的签名 OSS 链接，下载始终使用 HTTPS。
      return {
        bytes: await downloadProviderOutput(url.replace(/^http:/i, 'https:'), ['aliyuncs.com', 'alicdn.com']),
        mime: 'audio/wav',
      };
    }
    if (input.kind === 'matte') {
      const r = await jsonCall(
        'https://mediakit.cn-beijing.volces.com/api/v1/tools/matte-portrait-video',
        this.env.VOLC_MEDIAKIT_API_KEY!,
        { video_url: await this.mediaKitInput(userId, input.videoAssetId!, '视频'), format: 'WEBM' },
      );
      if (!r.task_id) throw new UncertainSubmission('视频抠像任务缺少任务 ID');
      return { pendingId: r.task_id };
    }
    if (input.kind === 'lipsync') {
      const response = await jsonCall(
        'https://mediakit.cn-beijing.volces.com/api/v1/tools/lip-sync',
        this.env.VOLC_MEDIAKIT_API_KEY!,
        {
          video_url: await this.mediaKitInput(userId, input.videoAssetId!, '视频'),
          audio_url: await this.mediaKitInput(userId, input.audioAssetId!, '音频'),
          enable_video_loop: input.loop ?? false,
        },
      );
      if (!response.task_id) throw new UncertainSubmission('上游未返回任务 ID，需核查后再提交');
      return { pendingId: response.task_id };
    }
    const relay = input.kind === 'motion' ? mediaRelayConfig(this.env) : undefined;
    const imageUrl = relay
      ? await relayMotionAsset(relay, this.objects, userId, input.imageAssetId!, 'image')
      : await this.objects.url(userId, input.imageAssetId!);
    let videoUrl: string | undefined;
    if (input.kind === 'motion' && input.videoAssetId)
      videoUrl = relay
        ? await relayMotionAsset(relay, this.objects, userId, input.videoAssetId, 'video')
        : await this.objects.url(userId, input.videoAssetId);
    const audioUrl =
      input.kind === 'avatar' && input.audioAssetId
        ? await this.objects.url(userId, input.audioAssetId)
        : undefined;
    if (this.env.VISUAL_PROVIDER !== 'gateway') {
      const visual = new VolcVisual(this.env);
      const id = await visual.submit(input, imageUrl, audioUrl, videoUrl);
      return { pendingId: `volc:${id}` };
    }
    // Optional institution gateway. Persist the chosen transport with the vendor task ID.
    const gateway = this.env.VISUAL_GATEWAY_URL;
    if (!gateway?.startsWith('https://')) throw new Error('动作/图片数字人网关尚未配置');
    const response = await jsonCall(`${gateway}/jobs`, this.env.VISUAL_GATEWAY_TOKEN!, {
      requestId,
      model: input.model,
      kind: input.kind,
      preset: input.preset,
      imageUrl,
      videoUrl,
      audioUrl,
      durationMs: input.durationMs,
    });
    if (!response.task_id) throw new UncertainSubmission('视觉网关未返回任务 ID');
    return { pendingId: `gateway:${response.task_id}` };
  }
  async poll(input: GenerationInput, providerId: string): Promise<ProviderResult> {
    if (providerId.startsWith('volc:')) {
      const result = await new VolcVisual(this.env).poll(input, providerId.slice(5));
      if ('pending' in result) return { pendingId: providerId };
      return {
        bytes: await this.downloadOutput(result.url, [
          'volcvideo.com',
          'volcvod.com',
          'volces.com',
          'byteimg.com',
          'ibytedtos.com',
          ...(this.env.VISUAL_OUTPUT_HOSTS ?? '').split(',').filter(Boolean),
        ]),
        mime: 'video/mp4',
      };
    }
    if (input.kind === 'clone') {
      const response = await jsonCall(`${this.ttsBase()}/customization`, this.env.DASHSCOPE_API_KEY!, {
        model: 'voice-enrollment',
        input: { action: 'query_voice', voice_id: providerId },
      });
      if (response.output?.status === 'OK') return { voiceId: providerId };
      if (response.output?.status === 'DEPLOYING') return { pendingId: providerId };
      throw new Error('音色复刻未就绪');
    }
    const mediakit = input.kind === 'lipsync' || input.kind === 'cutout' || input.kind === 'matte';
    const url = mediakit
      ? `https://mediakit.cn-beijing.volces.com/api/v1/tasks/${encodeURIComponent(providerId)}`
      : `${this.env.VISUAL_GATEWAY_URL}/jobs/${encodeURIComponent(providerId.replace(/^gateway:/, ''))}`;
    const response = await jsonCall(
      url,
      mediakit ? this.env.VOLC_MEDIAKIT_API_KEY! : this.env.VISUAL_GATEWAY_TOKEN!,
    );
    if (response.status === 'failed')
      throw new Error(`生成失败：${response.error?.code ?? 'provider_failure'}`);
    if (response.status !== 'completed') return { pendingId: providerId };
    if (input.kind === 'cutout') {
      if (!response.result?.image_url) throw new Error('火山抠图任务完成但没有图片');
      return this.portraitOutput(response.result.image_url, input.imageFrame);
    }
    const resultUrl = response.result?.video_url;
    if (!resultUrl) throw new Error('供应商任务完成但没有视频文件');
    const hosts = [
      'volcvideo.com',
      'volces.com',
      'byteimg.com',
      'ibytedtos.com',
      'tos-cn-beijing.volces.com',
      ...(this.env.VISUAL_OUTPUT_HOSTS ?? '').split(',').filter(Boolean),
    ];
    const bytes = await this.downloadVideoResult(resultUrl, [...hosts, 'volcvod.com']);
    if (input.kind === 'matte' || (input.kind === 'lipsync' && input.videoFrame)) {
      const folder = mkdtempSync(path.join(tmpdir(), 'mooc-check-matte-'));
      try {
        const file = path.join(folder, 'result.mov');
        writeFileSync(file, bytes);
        const ffmpeg =
          this.env.FFMPEG_PATH ||
          (this.env.FFPROBE_PATH
            ? path.join(
                path.dirname(this.env.FFPROBE_PATH),
                process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
              )
            : 'ffmpeg');
        const actual = await probe(file, this.env.FFPROBE_PATH);
        if (
          input.videoFrame &&
          (actual.width !== input.videoFrame.width || actual.height !== input.videoFrame.height)
        )
          throw new Error(
            `服务返回的尺寸 ${actual.width}×${actual.height} 与上传的 ${input.videoFrame.width}×${input.videoFrame.height} 不一致。`,
          );
        if (input.kind === 'lipsync') return { bytes, mime: 'video/mp4' };
        if (!actual.durationMs || Math.abs(actual.durationMs - (input.durationMs ?? 0)) > 100)
          throw new Error('视频抠像结果时长不匹配');
        if (!(await hasMatte(ffmpeg, file, actual.durationMs, actual.videoCodec)))
          throw new Error('视频抠像结果缺少有效的人物或透明背景。');
        return {
          bytes,
          mime: actual.container?.split(',').includes('webm') ? 'video/webm' : 'video/quicktime',
        };
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    }
    return { bytes, mime: 'video/mp4' };
  }
}
