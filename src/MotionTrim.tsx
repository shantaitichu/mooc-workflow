import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Scissors, Film, Repeat2, ScanLine, ZoomIn, ZoomOut, RefreshCw } from 'lucide-react';
import type { Asset, MotionCut } from '../shared/types';
import { motionCutSpec, snapMs } from '../shared/motion-track';
import { api } from './api';
import { OpenMediaLocation } from './OpenMediaLocation';

function FrameInput({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value / 1000));
  useEffect(() => setDraft(String(value / 1000)), [value]);
  function commit() {
    const parsed = Number(draft);
    const t =
      draft.trim() && Number.isFinite(parsed) ? Math.max(min, Math.min(max, snapMs(parsed * 1000))) : value;
    setDraft(String(t / 1000));
    if (t !== value) onCommit(t);
  }
  return (
    <label>
      {label}
      <input
        aria-label={label}
        type="number"
        min={min / 1000}
        max={max / 1000}
        step=".04"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
    </label>
  );
}

export function timecode(ms: number) {
  return (
    Math.floor(ms / 60000)
      .toString()
      .padStart(2, '0') +
    ':' +
    ((ms % 60000) / 1000).toFixed(2).padStart(5, '0')
  );
}

// Draw each source frame into the strip with a single decoder. Seeking the strip never changes the preview.
function Filmstrip({ src, total }: { src: string; total: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const cells = Math.max(10, Math.min(72, Math.ceil(total / 2000)));
  useEffect(() => {
    const canvas = ref.current,
      ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    let index = 0,
      live = true;
    function sample() {
      if (!live || index >= cells) return;
      video.currentTime = Math.max(0, Math.min(total - 40, (total * (index + 0.5)) / cells)) / 1000;
      if (!video.seeking && video.readyState >= 2) paint();
    }
    function paint() {
      if (!live || index >= cells || !ctx || !video.videoWidth) return;
      const ratio = Math.min(128 / video.videoWidth, 72 / video.videoHeight);
      const w = video.videoWidth * ratio,
        h = video.videoHeight * ratio;
      ctx.drawImage(video, index * 128 + (128 - w) / 2, (72 - h) / 2, w, h);
      index++;
      sample();
    }
    video.addEventListener('loadeddata', sample, { once: true });
    video.addEventListener('seeked', paint);
    video.src = src;
    return () => {
      live = false;
      video.removeEventListener('loadeddata', sample);
      video.removeEventListener('seeked', paint);
      video.removeAttribute('src');
      video.load();
    };
  }, [src, total, cells]);
  return <canvas className="motion-filmstrip" aria-hidden="true" ref={ref} width={cells * 128} height={72} />;
}

export function MotionTrim({
  source,
  courseId,
  busy,
  selection,
  onCut,
  suggest,
  suggestions,
  choose,
  openSource,
}: {
  source: Asset;
  courseId: string;
  busy: string;
  selection?: MotionCut;
  onCut: (cut: MotionCut) => void;
  suggest: () => void;
  suggestions: MotionCut[];
  choose: (cut: MotionCut) => void;
  openSource: () => void;
}) {
  const total = Math.floor((source.info.durationMs ?? 0) / 40) * 40,
    src = api.mediaUrl(courseId, source.id);
  const [start, setStart] = useState(0),
    [end, setEnd] = useState(Math.min(total, 3000));
  const [now, setNow] = useState(0),
    [name, setName] = useState(''),
    [loop, setLoop] = useState(false),
    [error, setError] = useState('');
  const [zoom, setZoom] = useState(1);
  const video = useRef<HTMLVideoElement>(null),
    rail = useRef<HTMLDivElement>(null),
    scroll = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    mode: 'start' | 'end' | 'seek' | 'move';
    x: number;
    anchor: number;
    left: number;
    right: number;
  } | null>(null);
  const length = end - start;
  let spec: ReturnType<typeof motionCutSpec> | undefined,
    rangeProblem = '';
  try {
    spec = motionCutSpec(length);
  } catch (e) {
    rangeProblem = e instanceof Error ? e.message : String(e);
  }
  function seek(ms: number) {
    const clamped = Math.max(0, Math.min(ms, total));
    if (video.current && video.current.readyState >= 1) video.current.currentTime = clamped / 1000;
    setNow(clamped);
  }
  function stop() {
    setLoop(false);
    video.current?.pause();
  }
  function change(which: 'start' | 'end' | 'seek', ms: number) {
    stop();
    if (which === 'start') {
      const t = Math.max(0, Math.min(end - 40, ms));
      setStart(t);
      seek(t);
    } else if (which === 'end') {
      const t = Math.min(total, Math.max(start + 40, ms));
      setEnd(t);
      seek(t - 40);
    } else seek(ms);
  }
  useEffect(() => {
    if (!selection || selection.sourceId !== source.id) return;
    stop();
    const a = Math.min(total - 40, snapMs(selection.startMs)),
      b = Math.min(total, Math.max(a + 40, snapMs(selection.endMs)));
    setStart(a);
    setEnd(b);
    setName(selection.name.slice(0, 60));
    seek(a);
    if (scroll.current && rail.current)
      scroll.current.scrollLeft = (a / total) * rail.current.offsetWidth - scroll.current.clientWidth * 0.3;
  }, [selection, source.id, total]);
  useEffect(() => {
    if (!loop || !video.current) return;
    const v = video.current;
    let active = true,
      waiting = false,
      frame = 0;
    function fail() {
      if (active) {
        setError('无法播放选段，请检查原视频。');
        setLoop(false);
      }
    }
    function ready() {
      if (active && !v.seeking && waiting) {
        waiting = false;
        void v.play().catch(fail);
      }
    }
    function rewind() {
      if (!active || waiting || v.readyState < 1) return;
      waiting = true;
      v.pause();
      v.currentTime = start / 1000;
      setNow(start);
      if (!v.seeking) ready();
    }
    function watch() {
      if (!active) return;
      if (!waiting && v.currentTime * 1000 >= end) rewind();
      frame = requestAnimationFrame(watch);
    }
    v.addEventListener('loadedmetadata', rewind);
    v.addEventListener('seeked', ready);
    v.addEventListener('ended', rewind);
    v.addEventListener('error', fail);
    rewind();
    watch();
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      v.removeEventListener('loadedmetadata', rewind);
      v.removeEventListener('seeked', ready);
      v.removeEventListener('ended', rewind);
      v.removeEventListener('error', fail);
      v.pause();
    };
  }, [loop, start, end, src]);
  const at = (x: number) => {
    const rect = rail.current!.getBoundingClientRect();
    return Math.min(total, snapMs((total * (x - rect.left)) / rect.width));
  };
  function down(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-side]');
    const mode =
      el?.dataset.side === 'start'
        ? 'start'
        : el?.dataset.side === 'end'
          ? 'end'
          : el?.dataset.side === 'move'
            ? 'move'
            : 'seek';
    const t = at(e.clientX);
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { mode, x: e.clientX, anchor: t, left: start, right: end };
    if (mode === 'seek') change('seek', t);
    else stop();
  }
  function move(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    const t = at(e.clientX);
    if (d.mode === 'move') {
      const a = Math.min(total - (d.right - d.left), Math.max(0, d.left + t - d.anchor));
      setStart(a);
      setEnd(a + d.right - d.left);
      seek(a);
    } else if (d.mode === 'seek') {
      if (Math.abs(e.clientX - d.x) < 3) return;
      const low = Math.min(d.anchor, t, total - 40);
      setStart(low);
      setEnd(Math.max(low + 40, Math.max(d.anchor, t)));
      seek(t);
    } else change(d.mode, t);
  }
  function rescale(value: number) {
    const next = Math.min(32, Math.max(1, value));
    setZoom(next);
    requestAnimationFrame(() => {
      const s = scroll.current,
        r = rail.current;
      if (s && r) s.scrollLeft = (now / total) * r.clientWidth - s.clientWidth * 0.35;
    });
  }
  function commit() {
    if (!spec || busy) return;
    const title = name.trim() || '动作 ' + timecode(start);
    stop();
    setError('');
    onCut({ sourceId: source.id, startMs: start, endMs: end, name: title });
  }
  if (total < 40) return <p>人物动作视频不足一帧，请更换素材。</p>;
  return (
    <section className="motion-trim cut-studio">
      <header className="cut-source">
        <div>
          <Film size={17} />
          <h2>人物动作视频</h2>
          <span className="cut-filename" title={source.name}>
            {source.name}
          </span>
          <span>{timecode(total)}</span>
        </div>
        <div>
          <OpenMediaLocation courseId={courseId} id={source.id} />
          <button onClick={openSource}>查看讲师档案</button>
        </div>
      </header>
      <div className="cut-deck">
        <div className="cut-monitor">
          <video
            className="trim-player"
            ref={video}
            src={src}
            controls={!loop}
            preload="auto"
            onTimeUpdate={(e) => setNow(e.currentTarget.currentTime * 1000)}
          />
        </div>
        <aside className="cut-inspector">
          <h3>选段设置</h3>
          <label>
            动作名称
            <input
              aria-label="选段名称"
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={'动作 ' + timecode(start)}
            />
          </label>
          <div className="cut-numbers">
            {(['start', 'end'] as const).map((side, i) => (
              <FrameInput
                key={side}
                label={i ? '出点（秒）' : '入点（秒）'}
                min={i ? start + 40 : 0}
                max={i ? total : end - 40}
                value={i ? end : start}
                onCommit={(t) => change(side, t)}
              />
            ))}
          </div>
          <div className="cut-receipt">
            <span>
              选段时长 <b>{(length / 1000).toFixed(2)} 秒</b>
            </span>
          </div>
          <button className="button primary cut-submit" disabled={!!busy || !spec} onClick={commit}>
            <Scissors size={16} /> 保存选段
          </button>
          {rangeProblem && <small role="status">{rangeProblem}</small>}
        </aside>
      </div>
      <section className="cut-timeline" aria-label="动作选段时间线">
        <div className="cut-toolbar">
          <strong>
            {timecode(now)} <small>/ {timecode(total)}</small>
          </strong>
          <button
            onClick={() => {
              setError('');
              setLoop(!loop);
            }}
            aria-pressed={loop}
          >
            <Repeat2 size={14} />
            {loop ? '停止选段预览' : '循环预览选段'}
          </button>
          <div className="cut-zoom">
            <button aria-label="缩小时间线" onClick={() => rescale(zoom / 2)} disabled={zoom === 1}>
              <ZoomOut size={15} />
            </button>
            <span>{zoom}×</span>
            <button aria-label="放大时间线" onClick={() => rescale(zoom * 2)} disabled={zoom === 32}>
              <ZoomIn size={15} />
            </button>
          </div>
        </div>
        <div className="cut-scroll" ref={scroll}>
          <div className="cut-extent" style={{ width: zoom * 100 + '%' }}>
            <div className="cut-ruler">
              {Array.from({ length: zoom * 4 + 1 }, (_, i) => (
                <span key={i}>{timecode((total * i) / (zoom * 4))}</span>
              ))}
            </div>
            <div
              className="cut-rail"
              ref={rail}
              onPointerDown={down}
              onPointerMove={move}
              onPointerUp={() => (drag.current = null)}
              onPointerCancel={() => (drag.current = null)}
              onLostPointerCapture={() => (drag.current = null)}
            >
              <Filmstrip src={src} total={total} />
              <div
                className="cut-region"
                style={{ left: (100 * start) / total + '%', width: (100 * length) / total + '%' }}
              >
                <div className="cut-grip" data-side="move" title="拖动整个选段" />
              </div>
              {(['start', 'end'] as const).map((side, i) => (
                <div
                  className={'cut-line ' + side}
                  data-side={side}
                  key={side}
                  style={{ left: (100 * (i ? end : start)) / total + '%' }}
                  title={i ? '拖动出点' : '拖动入点'}
                />
              ))}
              <div className="cut-playhead" style={{ left: (100 * now) / total + '%' }} />
            </div>
          </div>
        </div>
        <div className="cut-foot">
          <small>点击定位，拖动框选。拖动两端细线微调选段。</small>
          <button onClick={suggest} disabled={!!busy}>
            {busy === '识别动作选段' ? <RefreshCw size={14} className="spin" /> : <ScanLine size={14} />}{' '}
            识别动作选段
          </button>
        </div>
        {suggestions.length > 0 && (
          <div className="cut-suggestions" aria-label="识别到的选段">
            {suggestions.map((cut, i) => (
              <button key={i} onClick={() => choose(cut)}>
                {cut.name} · {timecode(cut.startMs)}–{timecode(cut.endMs)}
              </button>
            ))}
          </div>
        )}
        {error && <small role="alert">{error}</small>}
      </section>
    </section>
  );
}
