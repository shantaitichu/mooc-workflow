import { useMemo } from 'react';
import type { Course, Slide, CompositionSettings } from '../shared/types';
import { editTimeline } from '../shared/edit-timeline';
import { captionAt } from '../shared/subtitles';
import { EditTimeline } from './EditTimeline';
import { useEditTransport } from './useEditTransport';
import { SyncedVideo } from './SyncedVideo';
import { LayoutStage } from './LayoutStage';
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
  const transport = useEditTransport(course.id, pages, slide.id, selectPage, enabled);
  const page = pages.find((p) => p.id === slide.id)!;
  const local = Math.max(0, transport.time - page.start);
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
          {page.compositionId && !editLayout ? (
            <SyncedVideo
              key={page.compositionId}
              src={api.mediaUrl(course.id, page.compositionId)}
              time={local / 1000}
              playing={transport.playing}
            />
          ) : (
            <LayoutStage
              course={course}
              slide={slide}
              timeMs={local}
              durationMs={page.voiceEnd - page.start}
              playing={transport.playing}
              presenterId={page.videoId}
              caption={captionAt(page.captions, local)}
              onMove={onMove}
            />
          )}
        </div>
      </div>
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
