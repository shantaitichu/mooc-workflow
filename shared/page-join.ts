import type { Course, Slide } from './types';
import { compositionFor, currentArtifact, fingerprint } from './domain';
import { geometry } from './layout';

export const cleanPageModel = 'ffmpeg-1080p25-clean';
export function pageJoin(course: Course, slide: Slide, next?: Slide) {
  if (!next || slide.pagePauseMs < 120) return;
  const left = compositionFor(course, slide),
    right = compositionFor(course, next);
  if (
    [left, right].some((o) => o.layout === 'slides') ||
    slide.keepBackgroundAudio ||
    next.keepBackgroundAudio ||
    [slide, next].some((s) => s.videoModel === 'omnihuman-1.5')
  )
    return;
  const a = geometry(left).person,
    b = geometry(right).person;
  if (a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h) return;
  const idle = course.assets.find((v) => v.id === course.speaker.idleAssetId);
  const before = currentArtifact(course, slide, 'video'),
    after = currentArtifact(course, next, 'video');
  if (!before || !after || !idle?.info.transparent || !idle.info.durationMs) return;
  const { width, height } = idle.info;
  if (
    !width ||
    !height ||
    ![before, after].every((video) => {
      const v = course.assets.find((a) => a.id === video.assetId);
      return (
        v?.info.transparent &&
        v.info.width === width &&
        v.info.height === height &&
        v.info.videoCodec === 'vp9'
      );
    }) ||
    idle.info.videoCodec !== 'vp9'
  )
    return;
  const startMs = Math.round(before.durationMs / 40) * 40;
  const audio = currentArtifact(course, slide, 'audio');
  if (!audio || Math.abs(audio.durationMs - startMs) > 40) return;
  const end =
    currentArtifact(course, slide, 'composition')?.durationMs ?? audio.durationMs + slide.pagePauseMs;
  const frames = Math.round((end - startMs) / 40);
  if (frames < 3 || frames > 250 || Math.abs(40 * frames - slide.pagePauseMs) > 80) return;
  const input = {
    before: before.assetId,
    after: after.assetId,
    idle: idle.id,
    width,
    height,
    idleFrames: Math.max(1, Math.round(idle.info.durationMs / 40)),
    frames,
  };
  return { ...input, startMs, key: fingerprint({ version: 2, ...input }) };
}
export type PageJoin = NonNullable<ReturnType<typeof pageJoin>>;
