import { useEffect, useState } from 'react';
import { ArrowRight, Clapperboard, Film, FolderOpen, RefreshCw, Trash2 } from 'lucide-react';
import type { Course, MotionAsset, MotionCut, SavedMotionCut } from '../shared/types';
import { readyMotion } from '../shared/domain';
import { removeLibraryMotion } from '../shared/edit-timeline';
import { MotionTrim } from './MotionTrim';
import { SavedCutList } from './SavedCutList';
import { OpenMediaLocation } from './OpenMediaLocation';
import { findSavedCut } from '../shared/motion-track';
import { api } from './api';
import './motion-workspace.css';

interface Props {
  course: Course;
  accountId?: string;
  cloudUrl: string;
  busy: string;
  run: (label: string, action: (course: Course) => Promise<void>) => Promise<void>;
  goTo: (view: 'speaker' | 'editor' | 'settings') => void;
}

function MotionOptions({
  motion,
  busy,
  save,
}: {
  motion: MotionAsset;
  busy: boolean;
  save: (name: string, loopable: boolean) => void;
}) {
  const [name, setName] = useState(motion.name),
    [loopable, setLoopable] = useState(motion.loopable);
  useEffect(() => {
    setName(motion.name);
    setLoopable(motion.loopable);
  }, [motion.name, motion.loopable]);
  return (
    <details className="motion-options">
      <summary>素材设置</summary>
      <label>
        动作名称
        <input maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        <input type="checkbox" checked={loopable} onChange={(e) => setLoopable(e.target.checked)} />
        可在整页重复播放
      </label>
      <button
        className="button"
        disabled={busy || !name.trim() || (name.trim() === motion.name && loopable === motion.loopable)}
        onClick={() => save(name.trim(), loopable)}
      >
        保存素材设置
      </button>
    </details>
  );
}

export function MotionWorkspace({ course, accountId, cloudUrl, busy, run, goTo }: Props) {
  const source = course.assets.find((a) => a.id === course.speaker.videoAssetId);
  const idle = course.assets.find((a) => a.id === course.speaker.idleAssetId && a.info.transparent);
  const [check, setCheck] = useState(0);
  const [serviceProblem, setServiceProblem] = useState('正在检查动作服务…');
  const [message, setMessage] = useState('');
  const [suggestions, setSuggestions] = useState<MotionCut[]>([]);
  const [selected, setSelected] = useState<MotionCut>();
  useEffect(() => {
    setSelected(undefined);
    setSuggestions([]);
    setMessage('');
  }, [course.speaker.id, source?.id]);
  useEffect(() => {
    let active = true;
    if (!accountId) {
      setServiceProblem('请先在设置中登录本地后台，连接动作服务。');
      return;
    }
    setServiceProblem('正在检查动作服务…');
    void api
      .cloudOverview()
      .then(({ models }) => {
        if (!active) return;
        const missing = [
          ['dreamactor-2.0', 'Dreamactor 动作模仿'],
          ['mediakit-matte-portrait-video', 'MediaKit 视频抠像'],
        ].flatMap(([id, name]) => {
          const model = models.find((item) => item.id === id);
          return model?.available ? [] : [name + '：' + (model?.reason || '后台未提供此模型')];
        });
        setServiceProblem(missing.join('；'));
      })
      .catch((e) => {
        if (active) setServiceProblem('无法读取动作服务状态。' + e.message);
      });
    return () => {
      active = false;
    };
  }, [accountId, cloudUrl, check]);

  const available = course.speaker.motions.filter((m) => m.reviewed && readyMotion(course, m));
  const archived = course.speaker.motions.filter((m) => !available.includes(m));
  function remove(motion: MotionAsset) {
    const count = course.slides.filter(
      (s) => s.motionId === motion.id || s.motionTrack?.some((c) => c.motionId === motion.id),
    ).length;
    if (
      !window.confirm(
        '删除「' + motion.name + '」？' + (count ? '这会同时移除 ' + count + ' 页中的动作标记。' : ''),
      )
    )
      return;
    void run('删除动作', async (c) => {
      const next = structuredClone(c);
      removeLibraryMotion(next, motion.id);
      await api.saveCourse(next);
    });
  }
  const suggest = () => {
    setMessage('');
    void run('识别动作选段', async (c) => {
      const cuts = await api.suggestMotionCuts(c.id);
      setSuggestions(cuts);
      if (cuts.length) setSelected({ ...cuts[0] });
      else setMessage('未找到明显的动作分界，可直接在时间线上选择。');
    });
  };
  const generate = (cut: MotionCut, budget: number) => {
    setMessage('');
    void run('正在生成衔接动作', async (c) => {
      try {
        await api.createMotionFromCut(c.id, cut, budget);
        setMessage('「' + cut.name + '」已加入动作库，可在课程制作中拖入动作轨道。');
      } catch (e) {
        setMessage(e instanceof Error ? e.message : String(e));
        throw e;
      }
    });
  };
  function saveCut(cut: MotionCut) {
    void run('保存选段', async (c) => {
      if (c.speaker.id !== course.speaker.id || c.speaker.videoAssetId !== cut.sourceId)
        throw new Error('人物动作视频已更换，请重新选择片段。');
      const existing = findSavedCut(c, cut);
      if (existing) {
        setMessage('此时间范围已保存为「' + existing.name + '」。');
        return;
      }
      const next = structuredClone(c);
      (next.speaker.savedCuts ??= []).push({ ...cut, id: crypto.randomUUID() });
      await api.saveCourse(next);
      setMessage('已保存「' + cut.name + '」，可以继续截取下一段。');
    });
  }
  function removeCut(cut: SavedMotionCut) {
    if (!window.confirm('从已保存选段中删除「' + cut.name + '」？')) return;
    void run('删除选段', async (c) => {
      const next = structuredClone(c);
      next.speaker.savedCuts = next.speaker.savedCuts?.filter((item) => item.id !== cut.id);
      await api.saveCourse(next);
      setMessage('已删除选段「' + cut.name + '」。');
    });
  }
  function restore(m: MotionAsset) {
    void run('恢复动作', async (c) => {
      const copy = structuredClone(c);
      const clip = copy.speaker.motions.find((n) => n.id === m.id);
      if (!clip || !readyMotion(copy, clip)) throw new Error('待机形象已更换，请重新制作动作。');
      clip.reviewed = true;
      await api.saveCourse(copy);
    });
  }
  return (
    <div className="motion-workspace">
      {source?.info.transparent ? (
        <MotionTrim
          key={source.id}
          courseId={course.id}
          source={source}
          busy={busy}
          selection={selected}
          onCut={saveCut}
          suggest={suggest}
          suggestions={suggestions}
          choose={(cut) => setSelected({ ...cut })}
          openSource={() => goTo('speaker')}
        />
      ) : (
        <section className="motion-source-empty card">
          <Film size={32} />
          <h2>{source ? '人物动作视频需要先抠像' : '先导入人物动作视频'}</h2>
          <p>在讲师档案导入带透明背景的动作视频即可剪辑。普通视频可在档案中点击「移除视频背景」。</p>
          <button className="button primary" onClick={() => goTo('speaker')}>
            前往讲师档案 <ArrowRight size={14} />
          </button>
        </section>
      )}
      {message && (
        <p role="status" className="motion-result-message">
          {message}
        </p>
      )}
      <SavedCutList
        key={course.speaker.id}
        course={course}
        busy={busy}
        generate={generate}
        remove={removeCut}
        problem={!idle ? '生成动作前，请在讲师档案设置动态待机视频。' : serviceProblem}
        connectionAction={
          !idle ? () => goTo('speaker') : !accountId ? () => goTo('settings') : () => setCheck((x) => x + 1)
        }
        connectionLabel={!idle ? '设置待机' : !accountId ? '前往设置' : '刷新服务状态'}
      />
      <section className="motion-shelf" aria-label="动作库">
        <header>
          <h2>
            <Clapperboard size={18} /> 动作库 <small>{available.length} 段</small>
          </h2>
          <button className="button" onClick={() => goTo('editor')}>
            去课程编排 <ArrowRight size={14} />
          </button>
        </header>
        {available.length ? (
          <div className="motion-card-grid">
            {available.map((m) => {
              const asset = course.assets.find((a) => a.id === m.assetId)!;
              return (
                <article key={m.id} className="motion-item">
                  <video
                    className="alpha-preview"
                    controls
                    muted
                    loop
                    preload="metadata"
                    src={api.mediaUrl(course.id, m.assetId)}
                  />
                  <div>
                    <strong>{m.name}</strong>
                    <span>{((asset.info.durationMs ?? 0) / 1000).toFixed(2)} 秒 · 可用于课程</span>
                    <button
                      aria-label="删除动作"
                      title={'删除「' + m.name + '」'}
                      disabled={!!busy}
                      onClick={() => remove(m)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <OpenMediaLocation courseId={course.id} id={asset.id} />
                  <MotionOptions
                    motion={m}
                    busy={!!busy}
                    save={(name, loopable) => {
                      void run('保存素材设置', async (c) => {
                        const next = structuredClone(c),
                          motion = next.speaker.motions.find((item) => item.id === m.id);
                        if (!motion) throw new Error('此动作已删除。');
                        motion.name = name;
                        motion.loopable = loopable;
                        await api.saveCourse(next);
                      });
                    }}
                  />
                </article>
              );
            })}
          </div>
        ) : (
          <div className="motion-shelf-empty">
            <FolderOpen size={22} />
            <span>生成完成的动作会出现在这里，可拖入课程制作的动作轨道。</span>
          </div>
        )}
      </section>
      {!!archived.length && (
        <details className="motion-archive">
          <summary>历史素材与待处理片段（{archived.length}）</summary>
          <div className="motion-card-grid">
            {archived.map((m) => {
              const asset = course.assets.find((a) => a.id === m.assetId);
              const range = m.sourceClip?.split(':');
              const editable = range?.length === 3 && range[0] === source?.sha256;
              return (
                <article className="motion-item" key={m.id}>
                  {asset?.info.transparent && (
                    <video
                      controls
                      muted
                      preload="none"
                      className="alpha-preview"
                      src={api.mediaUrl(course.id, m.assetId)}
                    />
                  )}
                  <div>
                    <strong>{m.name}</strong>
                    <span>
                      {!asset?.info.transparent
                        ? '待移除背景'
                        : readyMotion(course, m)
                          ? '已生成，待加入课程'
                          : '需要与当前待机重新衔接'}
                    </span>
                    <button aria-label="删除历史动作" disabled={!!busy} onClick={() => remove(m)}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                  {asset && <OpenMediaLocation courseId={course.id} id={asset.id} />}
                  {readyMotion(course, m) ? (
                    <button className="button" disabled={!!busy} onClick={() => restore(m)}>
                      加入动作库
                    </button>
                  ) : editable && source && range ? (
                    <button
                      className="button"
                      disabled={!!busy}
                      onClick={() => {
                        setSelected({
                          sourceId: source.id,
                          startMs: Math.round(+range[1] * 1000),
                          endMs: Math.round(+range[2] * 1000),
                          name: m.name,
                        });
                        document.querySelector('.motion-trim')?.scrollIntoView({ block: 'center' });
                      }}
                    >
                      载入原选段
                    </button>
                  ) : (
                    !asset?.info.transparent &&
                    asset && (
                      <button
                        className="button"
                        disabled={!!busy}
                        onClick={() => {
                          if (window.confirm('按 ¥1/分钟移除旧素材背景？'))
                            void run('处理旧素材', async (c) => {
                              await api.prepareActorVideo(c.id, asset.id, 'candidate', m.id);
                            });
                        }}
                      >
                        <RefreshCw size={14} /> 移除背景
                      </button>
                    )
                  )}
                </article>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
}
