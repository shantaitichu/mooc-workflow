import type { Course, Slide, ProductionMode } from './types';
import {
  compositionFor,
  currentArtifact,
  estimatedDuration,
  matteCost,
  priceMicros,
  segmentsFor,
  speechFor,
  toSSML,
} from './domain';

export function estimateProduction(course: Course, slides: Slide[], mode: ProductionMode = 'full') {
  let audioMicros = 0,
    videoMicros = 0,
    reusedAudio = 0,
    reusedVideo = 0,
    reusedPages = 0,
    cloudJobs = 0;
  for (const slide of slides) {
    if (mode !== 'audio' && currentArtifact(course, slide, 'composition')) {
      reusedPages++;
      continue;
    }
    const speech = speechFor(course, slide);
    let pageMs = 0;
    for (const segment of segmentsFor(slide)) {
      const audio = currentArtifact(course, slide, 'audio', segment);
      if (audio) reusedAudio++;
      else if (
        mode !== 'video' &&
        !currentArtifact(course, slide, 'audio') &&
        !slide.recordedAudioId &&
        !slide.keepBackgroundAudio
      ) {
        let ssml: string;
        try {
          ssml = toSSML(segment.text, speech);
        } catch {
          ssml = segment.text;
        } // Keep invalid in-progress edits editable; submission validates them.
        const text =
          ssml.replace(/<[^>]*>/g, '') + [...ssml.matchAll(/alias="([^"]*)"/g)].map((m) => m[1]).join('');
        audioMicros += priceMicros({ kind: 'speech', model: speech.model, text, fingerprint: '' });
        cloudJobs++;
      }
      pageMs +=
        audio?.durationMs ??
        course.assets.find((a) => a.id === slide.recordedAudioId)?.info.durationMs ??
        estimatedDuration(segment.text, speech);
    }
    pageMs = currentArtifact(course, slide, 'audio')?.durationMs ?? pageMs;
    if (mode !== 'audio' && compositionFor(course, slide).layout !== 'slides' && !slide.keepBackgroundAudio) {
      if (currentArtifact(course, slide, 'video')) reusedVideo++;
      else {
        const durationMs = Math.max(1, pageMs);
        const model = slide.videoModel ?? 'mediakit-lipsync';
        videoMicros += priceMicros({
          kind: model === 'omnihuman-1.5' ? 'avatar' : 'lipsync',
          model,
          durationMs,
          fingerprint: '',
        });
        const frame =
          model === 'omnihuman-1.5'
            ? { width: 1920, height: 1080 }
            : course.assets.find((a) => a.id === course.speaker.idleAssetId)?.info;
        videoMicros += matteCost(durationMs, frame);
        cloudJobs += 2;
      }
    }
  }
  return {
    audioMicros,
    videoMicros,
    totalMicros: audioMicros + videoMicros,
    reusedAudio,
    reusedVideo,
    reusedPages,
    cloudJobs,
  };
}
