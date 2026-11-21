import './edit-timeline.css';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import {
  Clapperboard,
  Mic,
  Activity,
  Play,
  Pause,
  Volume2,
  VolumeX,
  SkipBack,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
} from 'lucide-react';
import { allowsActions, moveSentence, pageAt, reorderPage, type TimelinePage } from '../shared/edit-timeline';
import { readyMotion } from '../shared/domain';
import { snapMs } from '../shared/motion-track';
import type { Course } from '../shared/types';
import { api } from './api';
import type { EditTransport } from './useEditTransport';
export const timecode = (ms: number) => {
  const frames = Math.max(0, Math.floor(ms / 40));
  return [Math.floor(frames / 1500), Math.floor(frames / 25) % 60, frames % 25]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
};
type DragItem = { kind: 'page' | 'voice' | 'cue' | 'asset'; id: string; page?: string; offset?: number };
const mime = 'application/x-mooc-edit';
export function EditTimeline({
  course,
  pages,
  selectedId,
  transport: t,
  update,
  wide,
  toggleWide,
}: {
  course: Course;
  pages: TimelinePage[];
  selectedId: string;
  transport: EditTransport;
  update: (edit: (c: Course) => void) => void;
  wide: boolean;
  toggleWide: () => void;
}) {
  const [local, setLocal] = useState(false),
    [zoom, setZoom] = useState(1),
    [picked, setPicked] = useState(''),
    [notice, setNotice] = useState('');
  const axis = useRef<HTMLDivElement>(null),
    viewport = useRef<HTMLDivElement>(null);
  const p = pages.find((p) => p.id === selectedId) ?? pages[0],
    shown = local ? [p] : pages,
    origin = local ? p.start : 0,
    length = Math.max(40, local ? p.end - p.start : t.total),
    lib = course.speaker.motions.filter((m) => m.reviewed && readyMotion(course, m));
  const current = course.slides.find((s) => s.id === p.id)!;
  const selected = current.motionTrack?.find((c) => c.id === picked);
  const percent = (ms: number) => (100 * ms) / length + '%';
  function rect(start: number, end: number) {
    return { left: percent(start - origin), width: percent(end - start) };
  }
  function point(x: number) {
    const b = axis.current!.getBoundingClientRect();
    return Math.min(
      origin + length - 1,
      Math.max(origin, origin + snapMs((length * (x - b.left)) / b.width)),
    );
  }
  function drag(e: DragEvent, item: DragItem) {
    t.stop();
    e.dataTransfer.effectAllowed = item.kind === 'asset' ? 'copy' : 'move';
    e.dataTransfer.setData(mime, JSON.stringify(item));
  }
  function place(id: string, ms: number, originalPage?: string, cueId?: string) {
    const dest = pageAt(pages, ms);
    if (!dest) return;
    const slide = course.slides.find((s) => s.id === dest.id)!,
      at = snapMs(ms - dest.start);
    if (!allowsActions(course, slide)) {
      setNotice('此页的画面模式无法叠加动作。');
      return;
    }
    if (at >= dest.voiceEnd - dest.start) {
      setNotice('请把动作放在口播结束前。');
      return;
    }
    if (slide.motionTrack?.some((c) => c.id !== cueId && c.startMs === at)) {
      setNotice('此帧已有动作，请更换起点。');
      return;
    }
    const key = cueId ?? crypto.randomUUID();
    update((c) => {
      const src = c.slides.find((s) => s.id === originalPage),
        target = c.slides.find((s) => s.id === dest.id)!;
      if (src) src.motionTrack = src.motionTrack?.filter((i) => i.id !== key);
      target.motionTrack = [...(target.motionTrack ?? []), { id: key, motionId: id, startMs: at }].sort(
        (a, b) => a.startMs - b.startMs,
      );
    });
    setPicked(key);
    setNotice('');
    t.seek(dest.start + at);
  }
  function drop(e: DragEvent, lane: 'page' | 'voice' | 'cue') {
    e.preventDefault();
    const raw = e.dataTransfer.getData(mime);
    if (!raw) return;
    let item: DragItem;
    try {
      item = JSON.parse(raw);
    } catch {
      return;
    }
    const ms = point(e.clientX),
      dest = pageAt(pages, ms)!;
    setNotice('');
    if (lane === 'page' && item.kind === 'page') {
      const i = pages.indexOf(dest),
        before = ms < (dest.start + dest.end) / 2 ? dest.id : pages[i + 1]?.id;
      update((c) => reorderPage(c, item.id, before));
      return;
    }
    if (lane === 'voice' && item.kind === 'voice' && item.page) {
      const slide = course.slides.find((s) => s.id === dest.id)!;
      if (slide.recordedAudioId || slide.keepBackgroundAudio) {
        setNotice('整段录音绑定原声，不能插入口播句子。');
        return;
      }
      const before = dest.voices.find((v) => ms < (v.start + v.end) / 2)?.id;
      update((c) => moveSentence(c, item.page!, item.id, dest.id, before));
      return;
    }
    if (lane === 'cue') {
      if (item.kind === 'asset' && lib.some((m) => m.id === item.id)) place(item.id, ms);
      if (item.kind === 'cue') {
        const cue = course.slides.find((s) => s.id === item.page)?.motionTrack?.find((c) => c.id === item.id);
        if (cue) place(cue.motionId, Math.max(origin, ms - (item.offset ?? 0)), item.page, item.id);
      }
    }
  }
  useEffect(() => {
    const v = viewport.current;
    if (!t.playing || !v) return;
    const x = ((t.time - origin) / length) * v.scrollWidth;
    if (x < v.scrollLeft || x > v.scrollLeft + v.clientWidth) v.scrollLeft = x - v.clientWidth * 0.15;
  }, [t.time, t.playing, origin, length]);
  const activeVoice = p.voices.find((v) => v.start <= t.time && v.end > t.time);
  const laneProps = (lane: 'page' | 'voice' | 'cue') => ({
    onDragOver: (e: DragEvent) => e.preventDefault(),
    onDrop: (e: DragEvent) => drop(e, lane),
    onClick: (e: React.MouseEvent) => t.seek(point(e.clientX)),
  });
  return (
    <section
      className="edit-console"
      tabIndex={0}
      aria-label="多轨剪辑工作台"
      onKeyDown={(e) => {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
        if (e.key === ' ' && !(e.target instanceof HTMLButtonElement)) {
          e.preventDefault();
          t.toggle();
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          t.seek(t.time + (e.key === 'ArrowLeft' ? -40 : 40));
        }
      }}
    >
      <header className="edit-toolbar">
        <strong>多轨剪辑</strong>
        <button aria-label="回到起点" onClick={() => t.seek(origin)}>
          <SkipBack size={14} />
        </button>
        <button className="transport-toggle" aria-label="播放预览" title="同步播放或暂停" onClick={t.toggle}>
          {t.playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <output>
          {timecode(t.time)} <small>/ {timecode(t.total)}</small>
        </output>
        <button aria-label={t.muted ? '开启声音' : '静音'} onClick={() => t.setMuted(!t.muted)}>
          {t.muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
        </button>
        <div className="edit-view">
          <select
            aria-label="时间轴范围"
            value={local ? 'page' : 'course'}
            onChange={(e) => setLocal(e.target.value === 'page')}
          >
            <option value="course">全课</option>
            <option value="page">当前页</option>
          </select>
          <button aria-label="缩小时间轴" disabled={zoom === 1} onClick={() => setZoom(zoom / 2)}>
            <Minus size={13} />
          </button>
          <small>{zoom}×</small>
          <button aria-label="放大时间轴" disabled={zoom === 32} onClick={() => setZoom(zoom * 2)}>
            <Plus size={13} />
          </button>
          <button aria-label={wide ? '收起剪辑工作台' : '展开剪辑工作台'} onClick={toggleWide}>
            {wide ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      </header>
      <div className="edit-tracks">
        <div className="lane-labels">
          <div>时间尺</div>
          <div>
            <Clapperboard />
            视频主轨
          </div>
          <div>
            <Mic />
            逐句口播
          </div>
          <div>
            <Activity />
            人物动作
          </div>
        </div>
        <div className="edit-scroll" ref={viewport}>
          <div className="edit-content" style={{ width: zoom * 100 + '%' }}>
            <div
              ref={axis}
              className="edit-ruler"
              role="slider"
              tabIndex={0}
              aria-label="播放头"
              aria-valuemin={0}
              aria-valuemax={t.total}
              aria-valuenow={Math.round(t.time)}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                t.seek(point(e.clientX));
              }}
              onPointerMove={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) t.seek(point(e.clientX));
              }}
            >
              {Array.from({ length: 4 * zoom + 1 }, (_, i) => (
                <span key={i} style={{ left: (i / (4 * zoom)) * 100 + '%' }}>
                  {timecode(origin + (i / (4 * zoom)) * length)}
                </span>
              ))}
            </div>
            <div className="edit-lane video-lane" aria-label="视频主轨" {...laneProps('page')}>
              {shown.map((page) => (
                <button
                  key={page.id}
                  className={page.id === selectedId ? 'active' : ''}
                  style={rect(page.start, page.end)}
                  draggable={!local}
                  onDragStart={(e) => drag(e, { kind: 'page', id: page.id })}
                  title={'拖动调整页序 · ' + page.title}
                >
                  {page.thumbnail && <img draggable={false} src={api.mediaUrl(course.id, page.thumbnail)} />}
                  <span>
                    {pages.indexOf(page) + 1} · {page.title}
                  </span>
                </button>
              ))}
            </div>
            <div className="edit-lane voice-lane" aria-label="口播轨道" {...laneProps('voice')}>
              {shown.flatMap((page) =>
                page.voices.map((v) => (
                  <button
                    key={page.id + v.id}
                    className={
                      (v.assetId ? 'voiced ' : 'estimated ') +
                      (t.time >= v.start && t.time < v.end ? 'active' : '')
                    }
                    style={rect(v.start, v.end)}
                    draggable={v.editable}
                    onDragStart={(e) => drag(e, { kind: 'voice', id: v.id, page: page.id })}
                    title={v.text + ' · ' + (v.editable ? '拖动排列，双击预听' : '整段原声，双击预听')}
                    onDoubleClick={() => t.play(v.start, v.end)}
                  >
                    {v.text}
                  </button>
                )),
              )}
            </div>
            <div className="edit-lane motion-rail" aria-label="动作时间线" {...laneProps('cue')}>
              {shown.flatMap((page) => {
                const track = [...(course.slides.find((s) => s.id === page.id)?.motionTrack ?? [])].sort(
                  (a, b) => a.startMs - b.startMs,
                );
                return track.map((cue, i) => {
                  const m = course.speaker.motions.find((m) => m.id === cue.motionId),
                    len = course.assets.find((a) => a.id === m?.assetId)?.info.durationMs ?? 40;
                  const at = page.start + cue.startMs,
                    to = Math.min(at + len, page.voiceEnd, page.start + (track[i + 1]?.startMs ?? Infinity));
                  const invalid = to <= at,
                    display = invalid ? Math.max(page.start, page.end - 40) : at;
                  return (
                    <button
                      key={cue.id}
                      draggable
                      className={'motion-event ' + (picked === cue.id ? 'chosen' : '')}
                      style={rect(display, invalid ? page.end : to)}
                      title={(m?.name ?? '缺失动作') + (invalid ? ' · 起点超出页长' : '')}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPicked(cue.id);
                        t.seek(display);
                      }}
                      onDragStart={(e) =>
                        drag(e, {
                          kind: 'cue',
                          id: cue.id,
                          page: page.id,
                          offset: Math.max(0, point(e.clientX) - display),
                        })
                      }
                    >
                      {m?.name ?? '缺失动作'}
                    </button>
                  );
                });
              })}
            </div>
            <i
              className="edit-playhead"
              style={{ left: percent(Math.max(0, Math.min(length, t.time - origin))) }}
            />
          </div>
        </div>
      </div>
      <footer>
        <section className="course-motion-library" aria-label="课程可用动作">
          <div className="course-motion-heading">
            <strong>动作库</strong>
            <small>
              {lib.length
                ? '拖到人物动作轨，或点击插入播放头位置'
                : '在「动作素材」中截取并生成动作后，即可在这里编排。'}
            </small>
          </div>
          <div className="motion-palette">
            {lib.map((m) => (
              <button
                key={m.id}
                aria-label={m.name}
                draggable
                onDragStart={(e) => drag(e, { kind: 'asset', id: m.id })}
                onClick={() => place(m.id, t.time)}
                title={m.name + ' · 点击插入播放头位置，或拖到动作轨'}
              >
                {m.name}
                <small>
                  {((course.assets.find((a) => a.id === m.assetId)?.info.durationMs ?? 0) / 1000).toFixed(2)}{' '}
                  秒
                </small>
              </button>
            ))}
          </div>
        </section>
        {selected && (
          <div className="track-tools">
            <label>
              动作起点（秒）
              <input
                aria-label="动作起点（秒）"
                type="number"
                step=".04"
                min="0"
                value={selected.startMs / 1000}
                onChange={(e) =>
                  place(
                    selected.motionId,
                    p.start + Math.max(0, Math.min(p.end - p.start - 1, +e.target.value * 1000)),
                    p.id,
                    selected.id,
                  )
                }
              />
            </label>
            <button
              onClick={() => {
                t.stop();
                update((c) => {
                  const s = c.slides.find((s) => s.id === p.id)!;
                  s.motionTrack = s.motionTrack?.filter((m) => m.id !== selected.id);
                });
                setPicked('');
              }}
            >
              移除动作
            </button>
          </div>
        )}
        <small role="status">
          {t.error ||
            notice ||
            (activeVoice?.estimated
              ? activeVoice.assetId
                ? '整段原声播放 · 句界按稿件估算'
                : '此句尚无音频 · 按讲稿估时静音预演'
              : '拖动页面或口播句子排序，拖动时间尺定位。')}
        </small>
      </footer>
    </section>
  );
}
