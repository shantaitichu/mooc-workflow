import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import type {
  Course,
  Slide,
  SpeechSettings,
  CompositionSettings,
  Segment,
  Stage,
  GenerationInput,
} from './types';

export const motionPresets = {
  explain: '自然讲解',
  emphasize: '轻微强调',
  nod: '点头',
  greet: '开场问候',
  close: '收尾致意',
} as const;
export const defaultSpeech: SpeechSettings = {
  model: 'cosyvoice-v3.5-flash',
  speed: 1,
  sentencePauseMs: 280,
  paragraphPauseMs: 600,
  dictionary: [],
};
export const defaultComposition: CompositionSettings = {
  layout: 'split',
  presenterScale: 25,
  presenterX: 97,
  presenterY: 50,
  subtitleSize: 36,
  burnSubtitles: true,
  backgroundColor: '#ffffff',
};
export const id = () => globalThis.crypto.randomUUID();
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const fingerprint = (value: unknown) => bytesToHex(sha256(utf8ToBytes(canonical(value))));
export function voicePreviewFile(model: SpeechSettings['model'], voiceId: string) {
  const text = '大家好，欢迎来到今天的课程。';
  const key = fingerprint({ model, voiceId, text });
  return { text, key, name: '试听-' + key + '.wav' };
}
export const stripPauses = (text: string) => text.replace(/\[停顿\s*\d+\s*ms\]/g, '');
export const plainSpeech = (text: string) => stripPauses(text).trim();
export function newSlide(title = '未命名页面'): Slide {
  return {
    id: id(),
    title,
    originalText: '',
    spokenText: '',
    subtitleText: '',
    segments: [],
    backgroundStartMs: 0,
    shortBackground: 'freeze',
    keepBackgroundAudio: false,
    pagePauseMs: 600,
  };
}
export function newCourse(title: string): Course {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: id(),
    title: title.trim() || '未命名课程',
    description: '',
    revision: 0,
    createdAt: now,
    updatedAt: now,
    speech: structuredClone(defaultSpeech),
    composition: structuredClone(defaultComposition),
    slides: [],
    speaker: { id: id(), name: '我的讲师', voiceIds: {}, motions: [] },
    assets: [],
    artifacts: [],
  };
}
// Sentence-level segments remain stable across edits elsewhere in the slide. Never split a word to fit a provider limit.
export function segmentText(text: string, caption: string, previous: Segment[] = []): Segment[] {
  const chunks: string[] = [];
  for (const part of text.match(/[^。！？!?\n]+[。！？!?]?|\n+/g) ?? []) {
    if (!plainSpeech(part)) {
      if (chunks.length) chunks[chunks.length - 1] += part;
    } else chunks.push(part);
  }
  const captions =
    stripPauses(caption)
      .match(/[^。！？!?\n]+[。！？!?]?|\n+/g)
      ?.filter((s) => s.trim()) ?? [];
  const pools = new Map<string, Segment[]>();
  for (const s of previous) pools.set(s.text, [...(pools.get(s.text) ?? []), s]);
  return chunks.map((part, index) => {
    const existing = pools.get(part)?.shift();
    return {
      id: existing?.id ?? id(),
      take: existing?.take,
      text: part,
      caption: captions.length === chunks.length ? captions[index] : stripPauses(part),
    };
  });
}
export function updateNarration(slide: Slide, text: string, caption = slide.subtitleText): Slide {
  return {
    ...slide,
    spokenText: text,
    subtitleText: caption,
    segments: segmentText(text, caption || stripPauses(text), slide.segments),
  };
}
export const speechFor = (course: Course, slide: Slide): SpeechSettings => ({
  ...course.speech,
  ...slide.speechOverride,
});
export function compositionFor(course: Course, slide: Slide): CompositionSettings {
  const preset = course.layoutPresets?.find((p) => p.id === slide.layoutPresetId)?.settings;
  const base = preset ?? course.composition;
  const page = slide.compositionOverride;
  return {
    ...course.composition,
    ...preset,
    ...page,
    // A saved legacy alignment at a more specific level takes precedence over a canvas coordinate.
    deckLeft: page?.deckLeft ?? (page?.deckX === undefined ? base.deckLeft : undefined),
    deckTop: page?.deckTop ?? (page?.deckY === undefined ? base.deckTop : undefined),
  };
}
export const segmentsFor = (slide: Slide): Segment[] =>
  slide.recordedAudioId || slide.keepBackgroundAudio
    ? [
        {
          id: `${slide.id}-recording`,
          text: slide.spokenText,
          caption: slide.subtitleText || stripPauses(slide.spokenText),
        },
      ]
    : slide.segments;
const assetHash = (course: Course, assetId?: string) =>
  course.assets.find((a) => a.id === assetId)?.sha256 ?? assetId;
export function segmentFingerprint(
  course: Course,
  slide: Slide,
  segment: Segment,
  stage: 'audio' | 'video',
): string {
  const speech = speechFor(course, slide);
  const voiceId = course.speaker.voiceIds[speech.model];
  const audio = fingerprint(
    slide.recordedAudioId
      ? { stage: 'audio', version: 1, recording: assetHash(course, slide.recordedAudioId) }
      : slide.keepBackgroundAudio
        ? {
            stage: 'audio',
            version: 1,
            originalAudio: {
              source: assetHash(course, slide.backgroundAssetId),
              start: slide.backgroundStartMs,
              end: slide.backgroundEndMs,
            },
          }
        : {
            stage: 'audio',
            version: /\n$/.test(segment.text) ? 2 : 1,
            text: segment.text,
            take: segment.take ?? 0,
            speech,
            voice: voiceId ? fingerprint(voiceId) : course.speaker.voiceSignatures?.[speech.model],
          },
  );
  if (stage === 'audio') return audio;
  const motion = course.speaker.motions.find((m) => m.id === slide.motionId);
  return fingerprint({
    stage: 'video',
    version: 1,
    audio,
    take: slide.videoTake ?? 0,
    model: slide.videoModel ?? 'mediakit-lipsync',
    source: assetHash(course, motion?.assetId ?? course.speaker.videoAssetId),
    image: assetHash(course, course.speaker.imageAssetId),
    loop: motion?.loopable ?? false,
  });
}
export function slideFingerprint(course: Course, slide: Slide, stage: Stage = 'composition'): string {
  if (stage === 'video')
    return fingerprint({
      pageVideo: 4,
      idle: assetHash(course, course.speaker.idleAssetId),
      track: slide.motionTrack?.length
        ? [...slide.motionTrack]
            .sort((a, b) => a.startMs - b.startMs)
            .map((c) => [
              c.startMs,
              assetHash(course, course.speaker.motions.find((m) => m.id === c.motionId)?.assetId),
            ])
        : undefined,
      segments: segmentsFor(slide).map((s) => segmentFingerprint(course, slide, s, 'video')),
    });
  if (stage !== 'composition')
    return fingerprint(segmentsFor(slide).map((s) => segmentFingerprint(course, slide, s, stage)));
  const settings = compositionFor(course, slide);
  const caption = slide.subtitleText || stripPauses(slide.spokenText);
  const usesPresenter = settings.layout !== 'slides' && !slide.keepBackgroundAudio;
  return fingerprint({
    // Recompose affected pages locally. Keep the keys of paid speech and lip-sync artifacts.
    version:
      usesPresenter ||
      (settings.burnSubtitles && (caption || slide.segments.some((s) => s.caption))) ||
      settings.logoAssetId
        ? 3
        : 2,
    audio: slideFingerprint(course, slide, 'audio'),
    video: settings.layout === 'slides' ? null : slideFingerprint(course, slide, 'video'),
    page: assetHash(course, slide.assetId),
    title: slide.title,
    caption,
    // Preserve the historical fingerprint of pages rendered without a video colour key.
    composition: { ...settings, chromaKey: false },
    background: assetHash(course, slide.backgroundAssetId),
    logo: assetHash(course, settings.logoAssetId),
    backgroundStartMs: slide.backgroundStartMs,
    backgroundEndMs: slide.backgroundEndMs,
    shortBackground: slide.shortBackground,
    keepBackgroundAudio: slide.keepBackgroundAudio,
    pagePauseMs: slide.pagePauseMs,
  });
}
export function currentArtifact(course: Course, slide: Slide, stage: Stage, segment?: Segment) {
  const fp =
    segment && stage !== 'composition'
      ? segmentFingerprint(course, slide, segment, stage)
      : slideFingerprint(course, slide, stage);
  return [...course.artifacts]
    .reverse()
    .find(
      (a) =>
        a.slideId === slide.id && a.segmentId === segment?.id && a.stage === stage && a.fingerprint === fp,
    );
}
export function slideStatus(
  course: Course,
  slide: Slide,
): 'empty' | 'ready' | 'review' | 'approved' | 'stale' {
  if (!plainSpeech(slide.spokenText) && !slide.recordedAudioId && !slide.keepBackgroundAudio) return 'empty';
  const artifact = currentArtifact(course, slide, 'composition');
  if (artifact) return slide.reviewedFingerprint === artifact.fingerprint ? 'approved' : 'review';
  return course.artifacts.some((a) => a.slideId === slide.id) ? 'stale' : 'ready';
}
export function estimatedDuration(text: string, settings: SpeechSettings): number {
  const tokens = plainSpeech(text).match(/[\u3400-\u9fff]|[A-Za-z0-9]+/g)?.length ?? 0;
  const explicit = [...text.matchAll(/\[停顿\s*(\d+)\s*ms\]/g)].reduce((a, m) => a + Number(m[1]), 0);
  return Math.round(
    (tokens / (4.2 * settings.speed)) * 1000 +
      explicit +
      (text.match(/[。！？!?](?![\r\n])/g)?.length ?? 0) * settings.sentencePauseMs +
      (text.match(/\n/g)?.length ?? 0) * settings.paragraphPauseMs,
  );
}
export function validateCourse(course: Course): string[] {
  const issues: string[] = [];
  if (!course.slides.length) issues.push('请先导入课件或添加页面。');
  if (new Set(course.slides.map((s) => s.id)).size !== course.slides.length) issues.push('页面标识重复。');
  course.slides.forEach((slide, i) => {
    if (!plainSpeech(slide.spokenText) && !slide.recordedAudioId && !slide.keepBackgroundAudio)
      issues.push(`第 ${i + 1} 页缺少讲稿或录音。`);
    if (slide.keepBackgroundAudio && (plainSpeech(slide.spokenText) || slide.recordedAudioId))
      issues.push(`第 ${i + 1} 页同时启用了演示原声与讲解，请只保留一路。`);
    if (slide.keepBackgroundAudio && !slide.backgroundAssetId)
      issues.push(`第 ${i + 1} 页缺少带原声的背景视频。`);
    if (speechFor(course, slide).speed < 0.5 || speechFor(course, slide).speed > 2)
      issues.push(`第 ${i + 1} 页语速应为 0.5–2 倍。`);
    if (slide.segments.some((s) => plainSpeech(s.text).length > 500))
      issues.push(`第 ${i + 1} 页有超过 500 字的长句，请在语义边界分段。`);
    for (const match of slide.spokenText.matchAll(/\[停顿\s*(\d+)\s*ms\]/g))
      if (+match[1] > 10000 || +match[1] < 50) issues.push(`第 ${i + 1} 页停顿须为 50–10000ms。`);
    if (slide.motionTrack?.length) {
      if (slide.videoModel === 'omnihuman-1.5' || slide.motionId)
        issues.push('动作时间线需要使用整页口型驱动路线。');
      if (
        slide.motionTrack.some((c) => !course.speaker.motions.some((m) => m.id === c.motionId && m.reviewed))
      )
        issues.push('动作时间线含有未验收或缺失的素材。');
      if (new Set(slide.motionTrack.map((c) => Math.round(c.startMs / 40))).size !== slide.motionTrack.length)
        issues.push('同一帧存在重复动作。');
    }
    if (slide.motionId && !course.speaker.motions.find((m) => m.id === slide.motionId && m.reviewed))
      issues.push(`第 ${i + 1} 页使用了未验收的动作。`);
  });
  return [...new Set(issues)];
}
const xml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
export function toSSML(text: string, settings: SpeechSettings): string {
  const entries = settings.dictionary
    .filter((d) => d.text && d.alias)
    .sort((a, b) => b.text.length - a.text.length);
  let result = '';
  let i = 0;
  while (i < text.length) {
    const pause = text.slice(i).match(/^\[停顿\s*(\d+)\s*ms\]/);
    if (pause) {
      const ms = Number(pause[1]);
      if (ms < 50 || ms > 10000) throw new Error('停顿须为 50–10000ms');
      result += `<break time="${ms}ms"/>`;
      i += pause[0].length;
      continue;
    }
    const word = entries.find((e) => text.startsWith(e.text, i));
    if (word) {
      result += `<sub alias="${xml(word.alias)}">${xml(word.text)}</sub>`;
      i += word.text.length;
      continue;
    }
    const char = text[i++];
    result += xml(char);
    if (/[。！？!?]/.test(char) && !/^[\r\n]/.test(text.slice(i)) && settings.sentencePauseMs)
      result += `<break time="${settings.sentencePauseMs}ms"/>`;
    else if (char === '\n' && settings.paragraphPauseMs)
      result += `<break time="${settings.paragraphPauseMs}ms"/>`;
  }
  return `<speak>${result}</speak>`;
}
// MediaKit image smart edit: 1.38 CNY per 1000 successful cutouts.
export const portraitPriceMicros = 1380;
export const maxPresenterVideoMs = 5 * 60_000;
export const matteModel = 'mediakit-matte-portrait-video';
export function readyMotion(course: Course, m: Course['speaker']['motions'][number]) {
  const idle = course.assets.find((a) => a.id === course.speaker.idleAssetId);
  return (
    !!idle && m.idleHash === idle.sha256 && !!course.assets.find((a) => a.id === m.assetId)?.info.transparent
  );
}
export const portraitModel = 'mediakit-remove-image-background';
export function matteCost(durationMs: number, frame?: { width?: number; height?: number }) {
  const short = Math.min(frame?.width ?? 0, frame?.height ?? 0);
  const rate = short <= 720 ? 1 : short <= 1080 ? 1.5 : short <= 1440 ? 3 : 4;
  return Math.ceil(durationMs * rate * 1_000_000 / 60_000);
}
export function priceMicros(input: GenerationInput): number {
  if (input.kind === 'cutout') return portraitPriceMicros;
  if (input.kind === 'clone') return 0;
  if (input.kind === 'speech')
    return Array.from(input.text ?? '').length * (input.model.includes('plus') ? 150 : 80);
  const duration = input.durationMs ?? 0;
  if (duration <= 0 || !Number.isFinite(duration)) throw new Error('缺少有效的媒体时长');
  if (input.kind === 'matte') return matteCost(duration, input.videoFrame);
  return input.kind === 'lipsync'
    ? Math.ceil((duration * 1_000_000) / 60_000)
    : duration * (input.kind === 'motion' ? 500 : 1000);
}
export const money = (micros: number) =>
  '¥' +
  (micros !== 0 && Math.abs(micros) < 10000
    ? (micros / 1000000).toFixed(6).replace(/0+$/, '')
    : (micros / 1000000).toFixed(2));
export const clockText = (ms: number) =>
  `${Math.floor(ms / 60000)
    .toString()
    .padStart(2, '0')}:${Math.floor((ms / 1000) % 60)
    .toString()
    .padStart(2, '0')}`;
export function parsePageScript(text: string): { pages: Map<number, string>; warnings: string[] } {
  const pages = new Map<number, string>();
  const warnings: string[] = [];
  const sections = [
    ...text.matchAll(
      /^(?:#{1,4}\s*)?(?:第\s*(\d+)\s*页|\[\s*(\d+)\s*\]|Slide\s+(\d+))\s*[:：]?[^\S\r\n]*$/gim,
    ),
  ];
  if (!sections.length) return { pages, warnings: ['未找到页码标记。请使用独占一行的“第 1 页”或“[1]”。'] };
  sections.forEach((match, i) => {
    const page = Number(match[1] ?? match[2] ?? match[3]);
    const body = text.slice(match.index! + match[0].length, sections[i + 1]?.index ?? text.length).trim();
    if (pages.has(page)) warnings.push(`第 ${page} 页重复，保留首段，请手动核对。`);
    else pages.set(page, body);
  });
  return { pages, warnings };
}
