import { useEffect, useRef, useState } from 'react';
import { Play, Scissors, Trash2 } from 'lucide-react';
import type { Course, SavedMotionCut } from '../shared/types';
import { money, readyMotion } from '../shared/domain';
import { motionCutSpec } from '../shared/motion-track';
import { timecode } from './MotionTrim';
import { api } from './api';
import { OpenMediaLocation } from './OpenMediaLocation';

function CutPreview({ src, cut }: { src: string; cut: SavedMotionCut }) {
  const video = useRef<HTMLVideoElement>(null);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState('');
  function play() {
    const v = video.current;
    if (!v) return;
    setEnded(false);
    v.currentTime = cut.startMs / 1000;
    void v.play().catch((e) => {
      if (e.name !== 'AbortError') setError('选段无法播放，请检查源视频。');
    });
  }
  useEffect(() => {
    const v = video.current!;
    let frame = 0;
    function watch() {
      if (v.currentTime * 1000 >= cut.endMs || v.ended) {
        v.pause();
        if (v.currentTime * 1000 >= cut.endMs) v.currentTime = (cut.endMs - 40) / 1000;
        setEnded(true);
      } else if (!v.paused) frame = requestAnimationFrame(watch);
    }
    const start = () => {
      cancelAnimationFrame(frame);
      watch();
    };
    v.addEventListener('playing', start);
    return () => {
      cancelAnimationFrame(frame);
      v.removeEventListener('playing', start);
    };
  }, [cut.endMs]);
  return (
    <div className="saved-cut-player">
      <video
        ref={video}
        src={src}
        muted
        playsInline
        onLoadedData={play}
        onEnded={() => setEnded(true)}
        onError={() => setError('无法读取此选段的源视频。')}
        aria-label={cut.name + '选段预览'}
      />
      {error ? <small role="alert">{error}</small> : ended && <button onClick={play}>重播选段</button>}
    </div>
  );
}

interface Props {
  course: Course;
  busy: string;
  problem: string;
  connectionAction: () => void;
  connectionLabel: string;
  generate: (cut: SavedMotionCut, budget: number) => void;
  remove: (cut: SavedMotionCut) => void;
}
export function SavedCutList({
  course,
  busy,
  problem,
  connectionAction,
  connectionLabel,
  generate,
  remove,
}: Props) {
  const cuts = course.speaker.savedCuts ?? [];
  const [previewId, setPreviewId] = useState<string>();
  const frame = course.assets.find((a) => a.id === course.speaker.idleAssetId)?.info;
  return (
    <section className="motion-shelf" aria-label="已保存选段">
      <header>
        <h2>
          <Scissors size={18} /> 已保存选段 <small>{cuts.length} 段</small>
        </h2>
      </header>
      {cuts.length === 0 ? (
        <div className="motion-shelf-empty">在上方时间线上截取片段，点击「保存选段」后可在这里挑选生成。</div>
      ) : (
        <>
          {problem && (
            <div className="cut-service">
              <small>{problem}</small>
              <button onClick={connectionAction}>{connectionLabel}</button>
            </div>
          )}
          <div className="saved-cut-list">
            {cuts.map((cut) => {
              const source = course.assets.find((a) => a.id === cut.sourceId);
              const generated = course.speaker.motions.some(
                (m) => m.cutId === cut.id && readyMotion(course, m),
              );
              const durationMs = cut.endMs - cut.startMs;
              const budget = motionCutSpec(durationMs, frame).budgetMicros;
              const preview = previewId === cut.id;
              return (
                <article key={cut.id} aria-label={cut.name} className="saved-cut">
                  <div className="saved-cut-info">
                    <strong>{cut.name}</strong>
                    <small>
                      {source?.name ?? '源视频缺失'} · {timecode(cut.startMs)} – {timecode(cut.endMs)} ·{' '}
                      {(durationMs / 1000).toFixed(2)} 秒
                    </small>
                  </div>
                  <div className="saved-cut-actions">
                    <button
                      className="button"
                      disabled={!source}
                      aria-expanded={preview}
                      onClick={() => setPreviewId(preview ? undefined : cut.id)}
                    >
                      <Play size={14} />
                      {preview ? '收起预览' : '预览选段'}
                    </button>
                    <OpenMediaLocation courseId={course.id} id={cut.id} kind="cut" />
                    {generated ? (
                      <span>已生成</span>
                    ) : (
                      <button
                        className="button primary"
                        disabled={!!busy || !!problem || !source?.info.transparent}
                        onClick={() => {
                          if (
                            window.confirm(
                              '生成「' +
                                cut.name +
                                '」并加入动作库？首尾衔接和抠像预算上限为 ' +
                                money(budget) +
                                '。',
                            )
                          )
                            generate(cut, budget);
                        }}
                      >
                        生成动作素材 · {money(budget)}
                      </button>
                    )}
                    <button
                      className="icon-button"
                      title="删除选段"
                      aria-label={'删除选段「' + cut.name + '」'}
                      disabled={!!busy}
                      onClick={() => remove(cut)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  {preview && source && <CutPreview src={api.mediaUrl(course.id, source.id)} cut={cut} />}
                </article>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
