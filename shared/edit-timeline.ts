import type { Course, Slide, Segment } from './types';
import {
  compositionFor,
  currentArtifact,
  estimatedDuration,
  segmentsFor,
  speechFor,
  stripPauses,
} from './domain';
import { pageCaptionCues, type CaptionPart, type Cue } from './subtitles';

export interface VoiceClip {
  id: string;
  text: string;
  start: number;
  end: number;
  assetId?: string;
  offset: number;
  estimated: boolean;
  editable: boolean;
}
export interface TimelinePage {
  id: string;
  title: string;
  start: number;
  end: number;
  voiceEnd: number;
  voices: VoiceClip[];
  captions: Cue[];
  thumbnail?: string;
  compositionId?: string;
  videoId?: string;
}
export function editTimeline(course: Course): TimelinePage[] {
  let cursor = 0;
  return course.slides.map((slide) => {
    const start = cursor,
      voices: VoiceClip[] = [],
      captionParts: CaptionPart[] = [];
    const settings = speechFor(course, slide);
    const whole = !!(slide.recordedAudioId || slide.keepBackgroundAudio);
    const source = course.assets.find((a) => a.id === (slide.recordedAudioId ?? slide.backgroundAssetId));
    const finished = currentArtifact(course, slide, 'composition');
    for (const segment of segmentsFor(slide)) {
      const audio = currentArtifact(course, slide, 'audio', segment);
      const offset = whole && !slide.recordedAudioId && !audio ? slide.backgroundStartMs : 0;
      const originalLength = slide.recordedAudioId
        ? source?.info.durationMs
        : Math.max(
            0,
            Math.min(slide.backgroundEndMs ?? Infinity, source?.info.durationMs ?? 0) -
              slide.backgroundStartMs,
          );
      const duration =
        audio?.durationMs ??
        (whole && originalLength ? originalLength : Math.max(40, estimatedDuration(segment.text, settings)));
      const assetId = audio?.assetId ?? (whole ? source?.id : undefined);
      const parts = whole && slide.segments.length ? slide.segments : [segment];
      const weights = parts.map((s) => Math.max(1, estimatedDuration(s.text, settings)));
      const totalWeight = weights.reduce((a, b) => a + b, 0);
      let weight = 0,
        previous = 0;
      parts.forEach((s, i) => {
        weight += weights[i];
        const end = i === parts.length - 1 ? duration : Math.round((duration * weight) / totalWeight);
        voices.push({
          id: s.id,
          text: stripPauses(s.text).trim() || (slide.keepBackgroundAudio ? '演示原声' : '整页录音'),
          start: cursor + previous,
          end: cursor + end,
          assetId,
          offset: offset + previous,
          estimated: !assetId || (whole && parts.length > 1),
          editable: !whole,
        });
        previous = end;
      });
      captionParts.push({ text: segment.caption, durationMs: duration });
      cursor += duration;
    }
    const voiceEnd = cursor;
    cursor = start + Math.max(40, finished?.durationMs ?? cursor - start + slide.pagePauseMs);
    return {
      id: slide.id,
      title: slide.title,
      start,
      end: cursor,
      voiceEnd,
      voices,
      captions: pageCaptionCues(slide.subtitleText, captionParts),
      thumbnail: slide.assetId,
      compositionId: finished?.assetId,
      videoId:
        compositionFor(course, slide).layout !== 'slides'
          ? currentArtifact(course, slide, 'video')?.assetId
          : undefined,
    };
  });
}
export function pageAt(pages: TimelinePage[], at: number) {
  return pages.find((p) => at < p.end) ?? pages.at(-1);
}
export function allowsActions(course: Course, slide: Slide) {
  return (
    compositionFor(course, slide).layout !== 'slides' &&
    !slide.keepBackgroundAudio &&
    !slide.motionId &&
    (slide.videoModel ?? 'mediakit-lipsync') === 'mediakit-lipsync'
  );
}
// Splice at a cut between clips. Keep IDs and takes so that audio already generated for this page is reusable.
function insertAtCut<T extends { id: string }>(items: T[], item: T, before?: string) {
  const index = before ? items.findIndex((i) => i.id === before) : -1;
  items.splice(index < 0 ? items.length : index, 0, item);
}
export function reorderPage(course: Course, pageId: string, before?: string) {
  if (pageId === before) return;
  const idx = course.slides.findIndex((s) => s.id === pageId);
  if (idx >= 0) insertAtCut(course.slides, course.slides.splice(idx, 1)[0], before);
}
export function moveSentence(course: Course, fromId: string, id: string, toId: string, before?: string) {
  const from = course.slides.find((p) => p.id === fromId),
    to = course.slides.find((p) => p.id === toId);
  if (
    !from ||
    !to ||
    from.recordedAudioId ||
    to.recordedAudioId ||
    from.keepBackgroundAudio ||
    to.keepBackgroundAudio ||
    id === before
  )
    return;
  const index = from.segments.findIndex((s) => s.id === id);
  if (index < 0) return;
  const [clip] = from.segments.splice(index, 1);
  insertAtCut<Segment>(to.segments, clip, before);
  for (const p of new Set([from, to])) {
    p.spokenText = p.segments.map((s) => s.text).join('');
    p.subtitleText = p.segments.map((s) => s.caption).join('');
  }
}
export function removeLibraryMotion(course: Course, id: string) {
  course.speaker.motions = course.speaker.motions.filter((m) => m.id !== id);
  for (const s of course.slides) {
    if (s.motionId === id) delete s.motionId;
    if (s.motionTrack) s.motionTrack = s.motionTrack.filter((c) => c.motionId !== id);
  }
}
