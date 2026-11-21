import { compositionFor, currentArtifact, segmentsFor } from './domain';
import type { BatchPage, Course, PageOperation, ProductionBatch, Slide } from './types';

export function pageOutputs(course: Course, slide: Slide) {
  const segments = segmentsFor(slide);
  const parts = segments
    .map((segment) => currentArtifact(course, slide, 'audio', segment))
    .filter((a) => !!a);
  const audio = currentArtifact(course, slide, 'audio');
  const video = currentArtifact(course, slide, 'video');
  const composition = currentArtifact(course, slide, 'composition');
  const presenter = compositionFor(course, slide).layout !== 'slides' && !slide.keepBackgroundAudio;
  return { audio, parts, video, composition, presenter, total: segments.length };
}

export function batchCourse(course: Course, batch: ProductionBatch): Course {
  const ids = new Set(batch.pages.flatMap((page) => page.artifactIds));
  return {
    ...course,
    ...batch.settings,
    slides: batch.pages.map((page) => page.pending ?? page.slide),
    artifacts: course.artifacts.filter((a) => ids.has(a.id)),
  };
}

export function makeBatch(
  course: Course,
  slides: Slide[],
  id: string,
  createdAt: string,
  label: string,
): ProductionBatch {
  const { speech, composition, layoutPresets, speaker } = course;
  return {
    id,
    createdAt,
    label,
    settings: structuredClone({ speech, composition, layoutPresets, speaker }),
    pages: slides.map((slide) => {
      const output = pageOutputs(course, slide);
      return {
        number: course.slides.findIndex((s) => s.id === slide.id) + 1,
        slide: structuredClone(slide),
        artifactIds: [...output.parts, output.audio, output.video, output.composition].flatMap((a) =>
          a ? [a.id] : [],
        ),
      };
    }),
  };
}

export function repairSlide(
  page: BatchPage,
  operation: PageOperation,
  take: number,
  recordingId?: string,
): Slide {
  const slide = structuredClone(page.pending ?? page.slide);
  if (recordingId) {
    slide.recordedAudioId = recordingId;
    slide.keepBackgroundAudio = false;
  } else if (operation === 'audio') {
    if (slide.recordedAudioId || slide.keepBackgroundAudio)
      throw new Error('本页使用录音或演示原声，请在课程制作中更换源文件。');
    slide.segments.forEach((segment) => {
      segment.take = take;
    });
  } else if (operation === 'video') slide.videoTake = take;
  return slide;
}

export function outputLabels(course: Course, slide: Slide) {
  const { audio, parts, total, presenter, video, composition } = pageOutputs(course, slide);
  const previous = (stage: string) =>
    course.artifacts.some((a) => a.slideId === slide.id && a.stage === stage);
  return {
    audio:
      audio || (total > 0 && parts.length === total)
        ? '已有配音'
        : parts.length
          ? `配音 ${parts.length}/${total}`
          : previous('audio')
            ? '配音待更新'
            : '无配音',
    video: !presenter ? '无需人物' : video ? '已有人物视频' : previous('video') ? '人物待更新' : '无人物视频',
    composition: composition ? '已有成片' : previous('composition') ? '成片待更新' : '无成片',
  };
}
