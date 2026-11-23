import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { pageAt, type TimelinePage } from '../shared/edit-timeline';

interface Span {
  start: number;
  end: number;
  assetId?: string;
  offset: number;
}
function audioSpans(pages: TimelinePage[]) {
  const spans: Span[] = [];
  function append(s: Span) {
    if (s.end <= s.start) return;
    const previous = spans.at(-1);
    if (
      previous &&
      previous.end === s.start &&
      previous.assetId === s.assetId &&
      (!s.assetId || previous.offset + previous.end - previous.start === s.offset)
    )
      previous.end = s.end;
    else spans.push({ ...s });
  }
  for (const p of pages) {
    if (p.compositionId) {
      append({ start: p.start, end: p.end, assetId: p.compositionId, offset: 0 });
      continue;
    }
    for (const c of p.voices) append(c);
    append({ start: p.voiceEnd, end: p.end, offset: 0 });
  }
  return spans;
}
export function useEditTransport(
  courseId: string | undefined,
  pages: TimelinePage[],
  selectedId: string,
  select: (id: string) => void,
  enabled: boolean,
  preparePage?: (id: string) => Promise<void> | undefined,
) {
  const total = pages.at(-1)?.end ?? 0;
  const spans = useMemo(() => audioSpans(pages), [pages]);
  const [time, setTime] = useState(0),
    position = useRef(0),
    pageId = useRef('');
  const [range, setRange] = useState<{ end: number } | null>(null),
    [error, setError] = useState('');
  const [muted, setMuted] = useState(false),
    sound = useRef<HTMLAudioElement | null>(null);
  const show = useCallback(
    (t: number) => {
      const at = Math.max(0, Math.min(t, total)),
        p = pageAt(pages, at);
      position.current = at;
      setTime(at);
      if (p && pageId.current !== p.id) {
        pageId.current = p.id;
        select(p.id);
      }
    },
    [pages, total, select],
  );
  const seek = (ms: number) => {
    setRange(null);
    setError('');
    show(ms);
  };
  useEffect(() => {
    const p = pages.find((p) => p.id === selectedId);
    if (!p) return;
    if (pageId.current !== selectedId || position.current < p.start || position.current > p.end) {
      setRange(null);
      pageId.current = selectedId;
      position.current = p.start;
      setTime(p.start);
    }
  }, [selectedId, pages]);
  useEffect(() => {
    if (!enabled) setRange(null);
  }, [enabled]);
  useEffect(() => {
    if (sound.current) sound.current.muted = muted;
  }, [muted]);
  const muteRef = useRef(muted);
  muteRef.current = muted;
  useEffect(() => {
    if (!enabled || !range || !courseId) return;
    const limit = Math.min(range.end, total);
    let disposed = false,
      timer: ReturnType<typeof setInterval> | undefined;
    let media: HTMLAudioElement | undefined, prepared: HTMLAudioElement | undefined;
    function release(a?: HTMLAudioElement) {
      if (a) {
        a.onloadedmetadata = null;
        a.onended = null;
        a.onerror = null;
        a.pause();
        a.removeAttribute('src');
        a.load();
      }
    }
    function clear() {
      clearInterval(timer);
      release(media);
      media = undefined;
      sound.current = null;
    }
    async function start(at: number) {
      clear();
      if (disposed) return;
      show(at);
      const index = spans.findIndex((s) => s.end > at);
      if (at >= limit || index < 0) {
        setRange(null);
        return;
      }
      const span = spans[index],
        end = Math.min(span.end, limit);
      const page = pageAt(pages, at);
      try {
        if (page && preparePage) await preparePage(page.id);
      } catch (e) {
        if (!disposed) {
          setError('本地换页预览失败 · ' + String(e));
          setRange(null);
        }
        return;
      }
      if (disposed) return;
      if (!span.assetId) {
        const origin = performance.now();
        timer = setInterval(() => {
          const t = at + performance.now() - origin;
          t >= end ? start(end) : show(t);
        }, 32);
        return;
      }
      const url = api.mediaUrl(courseId!, span.assetId);
      if (prepared?.src === url) {
        media = prepared;
        prepared = undefined;
      } else {
        release(prepared);
        prepared = undefined;
        media = new Audio(url);
      }
      const a = media;
      sound.current = a;
      a.muted = muteRef.current;
      const next = spans[index + 1];
      if (next?.assetId && end < limit) {
        prepared = new Audio(api.mediaUrl(courseId!, next.assetId));
        prepared.preload = 'auto';
      }
      function fail() {
        if (disposed || media !== a) return;
        setError('该段音频无法播放，请检查本地素材或重新生成配音。');
        setRange(null);
      }
      function play() {
        if (disposed || media !== a) return;
        a.currentTime = (span.offset + at - span.start) / 1000;
        void a
          .play()
          .then(() => {
            if (disposed || media !== a) return;
            timer = setInterval(() => {
              if (a.seeking) return;
              const t = span.start + a.currentTime * 1000 - span.offset;
              t >= end ? start(end) : show(Math.max(at, t));
            }, 32);
          })
          .catch(fail);
      }
      a.onended = () => start(end);
      a.onerror = fail;
      if (a.readyState >= 1) play();
      else a.onloadedmetadata = play;
    }
    start(position.current);
    return () => {
      disposed = true;
      clear();
      release(prepared);
    };
  }, [enabled, range, spans, courseId, total, show, pages, preparePage]);
  function play(from = position.current, to = total) {
    if (!enabled || !total) return;
    show(from >= to ? 0 : from);
    setError('');
    setRange({ end: to });
  }
  return {
    time,
    total,
    playing: !!range,
    seek,
    play,
    stop: () => setRange(null),
    toggle: () => (range ? setRange(null) : play()),
    muted,
    setMuted,
    error,
  };
}
export type EditTransport = ReturnType<typeof useEditTransport>;
