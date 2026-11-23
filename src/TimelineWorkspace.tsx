import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Course, Slide, CompositionSettings } from '../shared/types';
import { editTimeline } from '../shared/edit-timeline';
import { captionAt } from '../shared/subtitles';
import { EditTimeline } from './EditTimeline';
import { useEditTransport } from './useEditTransport';
import { SyncedVideo } from './SyncedVideo';
import { LayoutStage } from './LayoutStage';
import { pageJoin } from '../shared/page-join';
import { currentArtifact } from '../shared/domain';
import { api } from './api';

interface Props {
  course: Course;
  slide: Slide;
  selectPage: (id: string) => void;
  editLayout: boolean;
  enabled: boolean;
  wide: boolean;
  toggleWide: () => void;
  update: (edit: (c: Course) => void) => void;
  onMove: (o: Partial<CompositionSettings>) => void;
  onSampleColor?: (x: number, y: number) => void;
}
export function TimelineWorkspace({
  course,
  slide,
  selectPage,
  editLayout,
  enabled,
  wide,
  toggleWide,
  update,
  onMove,
  onSampleColor,
}: Props) {
  const pages = useMemo(() => editTimeline(course), [course]);
  const page = pages.find((p) => p.id === slide.id)!;
  const index = pages.indexOf(page);
  const joins = useMemo(
    () => course.slides.map((s, i) => pageJoin(course, s, course.slides[i + 1])),
    [course],
  );
  const [ready, setReady] = useState<Record<string, string>>({});
  const [joinError, setJoinError] = useState('');
  const requests = useRef(new Map<string, Promise<void>>());
  const prepare = useCallback(
    (id: string) => {
      const i = course.slides.findIndex((s) => s.id === id);
      const spec = joins[i];
      if (!spec) return;
      const cacheKey = course.id + '/' + spec.key;
      const running = requests.current.get(cacheKey);
      if (running) return running;
      const task = api
        .preparePageJoin(course.id, id, course.slides[i + 1].id, spec.key)
        .then((url) => {
          if (url) setReady((previous) => ({ ...previous, [cacheKey]: url }));
          else requests.current.delete(cacheKey);
        })
        .catch((e) => {
          requests.current.delete(cacheKey);
          throw e;
        });
      requests.current.set(cacheKey, task);
      return task;
    },
    [course, joins],
  );
  const transport = useEditTransport(course.id, pages, slide.id, selectPage, enabled, prepare);
  const local = Math.max(0, transport.time - page.start);
  useEffect(() => {
    let active = true;
    setJoinError('');
    async function prefetch() {
      await prepare(slide.id);
      if (active && pages[index + 1]) await prepare(pages[index + 1].id);
    }
    if (enabled)
      void prefetch().catch((e) => {
        if (active) setJoinError(String(e));
      });
    return () => {
      active = false;
    };
  }, [enabled, index, pages, prepare, slide.id]);
  // Preload the next page while playing so the decoder is ready at the cut.
  const visiblePages = transport.playing && pages[index + 1] ? [index, index + 1] : [index];
  return (
    <>
      <div
        className={'preview-stage' + (onSampleColor ? ' sampling-color' : '')}
        onPointerDownCapture={
          onSampleColor
            ? (event) => {
                if (event.button !== 0 || !(event.target as Element).closest('.layout-stage')) return;
                event.preventDefault();
                event.stopPropagation();
                onSampleColor(event.clientX, event.clientY);
              }
            : undefined
        }
      >
        <div className="preview-viewport">
          {visiblePages.map((i) => {
            const p = pages[i],
              s = course.slides[i];
            const active = i === index;
            const timeMs = active ? local : 0;
            const join = joins[i],
              joinUrl = join && ready[course.id + '/' + join.key];
            const oldLabel = currentArtifact(course, s, 'composition')?.model === 'ffmpeg-1080p25';
            const useLayers = editLayout || oldLabel || !!join || !!joins[i - 1];
            return (
              <div
                key={p.id}
                className="preview-page"
                aria-hidden={!active}
                style={{
                  visibility: active ? 'visible' : 'hidden',
                  pointerEvents: active ? 'auto' : 'none',
                }}
              >
                {p.compositionId && !useLayers ? (
                  <SyncedVideo
                    src={api.mediaUrl(course.id, p.compositionId)}
                    time={timeMs / 1000}
                    playing={active && transport.playing}
                  />
                ) : (
                  <LayoutStage
                    course={course}
                    slide={s}
                    timeMs={timeMs}
                    durationMs={p.voiceEnd - p.start}
                    playing={active && transport.playing}
                    passive={!active}
                    presenterId={p.videoId}
                    join={join && joinUrl ? { src: joinUrl, startMs: join.startMs } : undefined}
                    caption={captionAt(p.captions, timeMs)}
                    onMove={onMove}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {joinError && <small role="alert">本地换页预览失败 · {joinError}</small>}
      <EditTimeline
        course={course}
        pages={pages}
        selectedId={slide.id}
        transport={transport}
        update={update}
        wide={wide}
        toggleWide={toggleWide}
      />
    </>
  );
}
