import { TimelineWorkspace } from './TimelineWorkspace';
import { CanvasSettings } from './CanvasSettings';
import { MotionWorkspace } from './MotionWorkspace';
import { presets, layoutNames } from '../shared/layout';
import { estimateProduction } from '../shared/estimate';
import { CloudTasks } from './CloudTasks';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  BookOpen,
  Layers3,
  UserRound,
  Clapperboard,
  ListChecks,
  Wallet,
  Settings,
  Plus,
  Upload,
  ChevronRight,
  ChevronLeft,
  Play,
  Download,
  Save,
  MoreHorizontal,
  Check,
  CheckCircle2,
  Clock3,
  MonitorPlay,
  Volume2,
  WandSparkles,
  ArrowUp,
  ArrowDown,
  Trash2,
  X,
  AlertCircle,
  FileText,
  Pause,
  RefreshCw,
  FolderOpen,
  ShieldCheck,
  Sparkles,
  LogOut,
  LayoutPanelLeft,
  Film,
  SlidersHorizontal,
  CircleHelp,
  ArrowRight,
  Search,
  LoaderCircle,
  Mic,
  Image as ImageIcon,
  Video,
} from 'lucide-react';
import type {
  Course,
  CompositionSettings,
  Slide,
  WorkspaceState,
  Layout,
  DesktopSettings,
  AssetKind,
  ModelEntry,
  Wallet as WalletType,
  LedgerEntry,
  ExportOptions,
} from '../shared/types';
import {
  compositionFor,
  currentArtifact,
  estimatedDuration,
  id,
  money,
  matteCost,
  readyMotion,
  newSlide,
  priceMicros,
  segmentsFor,
  slideFingerprint,
  slideStatus,
  speechFor,
  stripPauses,
  updateNarration,
  validateCourse,
  clockText,
  voicePreviewFile,
} from '../shared/domain';
import { api, isPreview } from './api';
import { motionCutSpec } from '../shared/motion-track';
import { ProductionHistory } from './ProductionHistory';
import { outputLabels } from '../shared/production-batches';
import { History } from './History';
import { ReplaceDeck } from './ReplaceDeck';
import { Waveform } from './Waveform';
import { SpeakerLibrary } from './SpeakerLibrary';
import { OpenMediaLocation } from './OpenMediaLocation';

const statusLabels = {
  empty: '待补讲稿',
  ready: '待生成',
  review: '待审核',
  approved: '已通过',
  stale: '需要更新',
};
type View = 'editor' | 'speaker' | 'motions' | 'tasks' | 'billing' | 'settings';
function Button({
  children,
  onClick,
  primary,
  disabled,
  className = '',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`button ${primary ? 'primary' : ''} ${className}`}
    >
      {children}
    </button>
  );
}
function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  return (
    <div
      className="modal-shade"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={close} aria-label="关闭">
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function Empty({
  icon,
  title,
  text,
  children,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon}
      <h3>{title}</h3>
      <p>{text}</p>
      {children}
    </div>
  );
}

export default function App() {
  const [state, setState] = useState<WorkspaceState>();
  const [course, setCourse] = useState<Course>();
  const [selectedId, setSelectedId] = useState('');
  const [view, setView] = useState<View>('editor');
  const [tab, setTab] = useState<'script' | 'layout' | 'versions'>('script');
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const courseRef = useRef<Course | undefined>(undefined);
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState('');
  const [dialog, setDialog] = useState<'create' | 'generate' | 'retake' | 'export' | 'help' | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [sampleId, setSampleId] = useState<string>();
  const [budget, setBudget] = useState(30);
  const [exportOptions, setExportOptions] = useState<ExportOptions>({
    subtitles: true,
    perSlide: false,
    audio: true,
    project: true,
  });
  const [overview, setOverview] = useState<{
    wallet: WalletType;
    ledger: LedgerEntry[];
    models: ModelEntry[];
  }>();
  const [settings, setSettings] = useState<DesktopSettings>();
  const [email, setEmail] = useState('admin@example.local');
  const [password, setPassword] = useState('');
  const [grantAmount, setGrantAmount] = useState(100);
  const [dictionaryText, setDictionaryText] = useState('');
  const scriptRef = useRef<HTMLTextAreaElement>(null);
  const [wide, setWide] = useState(false);
  const [marked, setMarked] = useState<string[]>([]);
  const [presetName, setPresetName] = useState('');
  const [colorPicker, setColorPicker] = useState<AbortController>();
  useEffect(() => {
    setColorPicker(undefined);
  }, [selectedId, course?.id, tab, view]);
  useEffect(() => {
    if (!colorPicker) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setColorPicker(undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      colorPicker.abort();
      window.removeEventListener('keydown', onKey);
    };
  }, [colorPicker]);
  const [voiceList, setVoiceList] = useState<Array<{ id: string; model: string; created_at: string }>>([]);
  const [audition, setAudition] = useState<{ voice: string; asset: string; course: string }>();
  useEffect(() => {
    setMarked([]);
    setPresetName('');
  }, [course?.id]);
  useEffect(() => {
    let active = true;
    setVoiceList([]);
    if (view === 'speaker' && state?.account)
      void api
        .voices()
        .then((items) => {
          if (active) setVoiceList(items);
        })
        .catch((e) => {
          if (active) setToast(e.message);
        });
    return () => {
      active = false;
    };
  }, [view, state?.account?.id, course?.speaker.voiceIds[course.speech.model]]);
  courseRef.current = course;
  dirtyRef.current = dirty;
  async function refresh() {
    const result = await api.state();
    setState(result);
    setSettings((s) => s ?? result.settings);
    setCourse((current) => {
      const next = result.courses.find((c) => c.id === current?.id) ?? result.courses[0];
      if (!current || !dirtyRef.current) return next;
      if (!next || next.id !== current.id) return current;
      return {
        ...current,
        revision: next.revision,
        assets: next.assets,
        artifacts: next.artifacts,
        batches: next.batches,
        speaker: { ...current.speaker, voiceIds: next.speaker.voiceIds },
      };
    });
  }
  useEffect(() => {
    void refresh();
    return api.onChange(() => {
      void refresh();
    });
  }, []);
  useEffect(() => {
    if (!course?.slides.some((s) => s.id === selectedId)) setSelectedId(course?.slides[0]?.id ?? '');
  }, [course?.id, course?.slides.length]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 6500);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);
  const slide = course?.slides.find((s) => s.id === selectedId);
  const index = course?.slides.findIndex((s) => s.id === selectedId) ?? 0;
  const update = (fn: (c: Course) => void) => {
    setCourse((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      fn(next);
      return next;
    });
    setDirty(true);
  };
  const updateSlide = (fn: (s: Slide) => void) =>
    update((c) => {
      const s = c.slides.find((s) => s.id === selectedId);
      if (s) fn(s);
    });
  const changeComposition = (settings: Partial<CompositionSettings>) =>
    updateSlide((s) => {
      s.compositionOverride = { ...s.compositionOverride, ...settings };
    });
  async function samplePreviewColor(x: number, y: number) {
    if (!colorPicker) return;
    try {
      const color = await api.previewColor(x, y);
      if (!colorPicker.signal.aborted) changeComposition({ backgroundColor: color });
    } catch (e) {
      if (!colorPicker.signal.aborted) setToast(e instanceof Error ? e.message : '预览取色失败，请重试。');
    } finally {
      setColorPicker((current) => (current === colorPicker ? undefined : current));
    }
  }
  async function act(label: string, fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }
  async function save() {
    if (!courseRef.current) return;
    const saved = await api.saveCourse(courseRef.current);
    setCourse(saved);
    courseRef.current = saved;
    dirtyRef.current = false;
    setDirty(false);
    return saved;
  }
  async function beforeNative(fn: (c: Course) => Promise<void>) {
    const saved = dirtyRef.current ? await save() : courseRef.current;
    try {
      if (saved) await fn(saved);
    } finally {
      // Imports and model jobs may have saved local progress before a later step fails.
      await refresh();
    }
  }
  async function importAsset(kind: AssetKind, use: (c: Course, assetId: string) => void) {
    await beforeNative(async (c) => {
      const result = await api.importAsset(c.id, kind);
      if (result) {
        use(result.course, result.asset.id);
        const saved = await api.saveCourse(result.course);
        setCourse(saved);
        if (result.asset.info.warnings.length) setToast(result.asset.info.warnings.join('\n'));
      }
    });
  }
  const duration =
    course?.slides.reduce(
      (sum, s) =>
        sum +
        (currentArtifact(course, s, 'composition')?.durationMs ??
          estimatedDuration(s.spokenText, speechFor(course, s)) + s.pagePauseMs),
      0,
    ) ?? 0;
  const sample = sampleId !== undefined;
  const productionCourse = dialog === 'retake' && course ? {
    ...course, slides: course.slides.map(s => s.id === sampleId ? { ...s, videoTake: (s.videoTake ?? 0) + 1 } : s),
  } : course;
  const productionPages = sample ? productionCourse?.slides.filter((s) => s.id === sampleId) : productionCourse?.slides;
  const estimate =
    productionCourse && productionPages && (dialog === 'generate' || dialog === 'retake')
      ? estimateProduction(productionCourse, productionPages) : undefined;
  const passed = course?.slides.filter((s) => slideStatus(course, s) === 'approved').length ?? 0;
  const artifact = course && slide ? currentArtifact(course, slide, 'composition') : undefined;
  const options = course && slide ? compositionFor(course, slide) : undefined;
  const voiceId = course?.speaker.voiceIds[course.speech.model];
  const activeAudition = audition && audition.course === course?.id && audition.voice === voiceId ? audition.asset : undefined;
  const sampleName = view === 'speaker' && course && voiceId ? voicePreviewFile(course.speech.model, voiceId).name : undefined;
  const auditionAsset = activeAudition ?? (sampleName && course?.assets.find(a => a.kind === 'audio' && a.name === sampleName)?.id);
  const currentTasks = state?.tasks.filter((t) => t.courseId === course?.id) ?? [];
  const nav: Array<{ key: View; icon: ReactNode; title: string }> = [
    { key: 'editor', icon: <Layers3 />, title: '课程制作' },
    { key: 'speaker', icon: <UserRound />, title: '讲师档案' },
    { key: 'motions', icon: <Clapperboard />, title: '动作素材' },
    { key: 'tasks', icon: <ListChecks />, title: '制作任务' },
    { key: 'billing', icon: <Wallet />, title: '额度与账单' },
  ];
  if (!state)
    return (
      <div className="loading">
        <LoaderCircle className="spin" />
        正在打开本地工作区…
      </div>
    );
  return (
    <div className="app-shell">
      <aside className="app-nav">
        <div className="brand">
          <div className="brand-symbol">
            <BookOpen size={24} />
          </div>
          <div>
            <strong>慕课工坊</strong>
            <span>MOOC STUDIO</span>
          </div>
        </div>
        <div className="workspace-label">
          制作工作台 <span>V1</span>
        </div>
        <nav>
          {nav.map((n) => (
            <button
              key={n.key}
              className={view === n.key ? 'active' : ''}
              onClick={() => {
                setView(n.key);
                if (n.key === 'billing' && state.account)
                  void act('读取账单', async () => setOverview(await api.cloudOverview()));
              }}
            >
              {n.icon}
              <span>{n.title}</span>
              {n.key === 'tasks' && state.tasks.some((t) => t.status === 'running') && (
                <i className="activity-dot" />
              )}
            </button>
          ))}
        </nav>
        <div className="nav-tip">
          <ShieldCheck size={21} />
          <strong>本地制作，按需上云</strong>
          <p>
            课件和工程留在电脑，
            <br />
            仅上传生成所需的素材。
          </p>
        </div>
        <div className="nav-bottom">
          <button onClick={() => setDialog('help')}>
            <CircleHelp />
            制作指南
          </button>
          <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>
            <Settings />
            设置与连接
          </button>
          <div className="account">
            <span className="avatar">{state.account ? '教' : '本'}</span>
            <div>
              <b>{state.account ? '机构工作区' : '本地工作区'}</b>
              <small>{state.account?.email ?? (isPreview ? '浏览器编辑预览' : '尚未连接云服务')}</small>
            </div>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumbs">
            我的课程
            <ChevronRight size={14} />
            <select
              aria-label="切换课程"
              value={course?.id ?? ''}
              onChange={(e) => {
                if (dirty) {
                  setToast('请先保存当前更改再切换课程。');
                  return;
                }
                setCourse(state.courses.find((c) => c.id === e.target.value));
              }}
            >
              <option value="" disabled>
                选择课程
              </option>
              {state.courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </div>
          <div className="top-actions">
            <span className="local-status">
              <i />
              {isPreview ? '浏览器预览' : '本地工程'}
            </span>
            <button className="icon-button" title="新建课程" onClick={() => setDialog('create')}>
              <Plus size={18} />
            </button>
          </div>
        </header>
        {view === 'editor' && (
          <>
            <section className="page-heading">
              <div>
                <div className="eyebrow">COURSE WORKSPACE</div>
                <h1>{course?.title ?? '开始制作你的第一门课程'}</h1>
                <p>
                  {course
                    ? `${course.slides.length} 个页面　·　预计 ${clockText(duration)}　·　${passed} 页已审核`
                    : '把讲稿、课件和讲师素材，变成一堂有温度的课。'}
                </p>
              </div>
              <div className="heading-actions">
                <span className={dirty ? 'save-state unsaved' : 'save-state'}>
                  {dirty ? (
                    '有未保存更改'
                  ) : (
                    <>
                      <Check size={14} />
                      已保存到本地
                    </>
                  )}
                </span>
                <Button disabled={!course || !dirty || !!busy} onClick={() => void act('保存', save)}>
                  <Save size={15} />
                  保存
                </Button>
                <Button
                  primary
                  disabled={!course?.slides.length || !!busy}
                  onClick={() => setDialog('export')}
                >
                  <Download size={16} />
                  导出课程
                </Button>
              </div>
            </section>
            <div className="workflow">
              <span className="done">
                <Check size={13} />
                导入课件
              </span>
              <ChevronRight />
              <span className="current">
                <span className="step-number">2</span>编辑与配音
              </span>
              <ChevronRight />
              <span>3　确认样片</span>
              <ChevronRight />
              <span>4　批量生成</span>
              <ChevronRight />
              <span>5　审核与导出</span>
              <button onClick={() => setDialog('help')}>
                了解制作流程
                <ArrowRight size={13} />
              </button>
            </div>
            {!course ? (
              <Empty
                icon={<BookOpen size={42} />}
                title="从一页课件开始"
                text="支持 PPTX、PDF 和图片，讲稿可以从 PPT 备注读取。"
              >
                <Button primary onClick={() => setDialog('create')}>
                  <Plus size={16} />
                  新建课程
                </Button>
                <Button
                  onClick={() =>
                    void act('恢复工程', async () => {
                      const c = await api.restoreProject();
                      if (c) {
                        await refresh();
                        setCourse(c);
                      }
                    })
                  }
                >
                  恢复工程包
                </Button>
              </Empty>
            ) : (
              <div className={'editor-grid ' + (wide ? 'wide-editor' : '')}>
                <section className="slide-panel">
                  <div className="panel-title">
                    <strong>
                      课件页面 <span>{course.slides.length}</span>
                    </strong>
                    <button
                      className="icon-button"
                      title="添加空白页"
                      onClick={() =>
                        update((c) => {
                          const s = newSlide(`第 ${c.slides.length + 1} 页`);
                          c.slides.push(s);
                          setSelectedId(s.id);
                        })
                      }
                    >
                      <Plus size={17} />
                    </button>
                  </div>
                  {course.slides.length > 0 && (
                    <div className="page-selection">
                      <span>
                        已选 {marked.filter((id) => course.slides.some((s) => s.id === id)).length} 页
                      </span>
                      <button onClick={() => setMarked(course.slides.map((s) => s.id))}>全选</button>
                      <button
                        onClick={() =>
                          setMarked(course.slides.filter((s) => !marked.includes(s.id)).map((s) => s.id))
                        }
                      >
                        反选
                      </button>
                      {(['删除所选', '只保留所选'] as const).map((label, i) => (
                        <button
                          key={label}
                          disabled={!marked.some((id) => course.slides.some((s) => s.id === id))}
                          onClick={() => {
                            const retained = course.slides.filter((s) =>
                              i ? marked.includes(s.id) : !marked.includes(s.id),
                            );
                            if (retained.length === course.slides.length) return;
                            if (
                              window.confirm(
                                '将从课程移除 ' +
                                  (course.slides.length - retained.length) +
                                  ' 页，保留 ' +
                                  retained.length +
                                  ' 页。',
                              )
                            ) {
                              update((c) => {
                                c.slides = retained;
                              });
                              setMarked([]);
                              if (!retained.some((s) => s.id === selectedId))
                                setSelectedId(retained[0]?.id ?? '');
                            }
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="slide-list">
                    {course.slides.map((s, i) => (
                      <div className="selectable-slide" key={s.id}>
                        <input
                          type="checkbox"
                          aria-label={'选择第 ' + (i + 1) + ' 页'}
                          checked={marked.includes(s.id)}
                          onChange={(e) =>
                            setMarked(
                              e.target.checked ? [...marked, s.id] : marked.filter((id) => id !== s.id),
                            )
                          }
                        />
                        <button
                          className={`slide-card ${s.id === selectedId ? 'selected' : ''}`}
                          onClick={() => {
                            setSelectedId(s.id);
                          }}
                        >
                          <div className="slide-number">{String(i + 1).padStart(2, '0')}</div>
                          <div className="slide-card-body">
                            <div className="thumbnail">
                              {s.assetId ? (
                                <img src={api.mediaUrl(course.id, s.assetId)} />
                              ) : (
                                <div className="thumb-placeholder">
                                  <span>MOOC / {String(i + 1).padStart(2, '0')}</span>
                                  <b>{s.title}</b>
                                  <i />
                                  <i />
                                </div>
                              )}
                              <span className="thumb-duration">
                                {clockText(estimatedDuration(s.spokenText, speechFor(course, s)))}
                              </span>
                            </div>
                            <div className="slide-caption">
                              <strong>{s.title}</strong>
                              <span className={`status-dot ${slideStatus(course, s)}`} />
                            </div>
                            <small>{Object.values(outputLabels(course, s)).join(' · ')}</small>
                            <small>{statusLabels[slideStatus(course, s)]}</small>
                          </div>
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="slide-panel-bottom">
                    <Button
                      onClick={() =>
                        void act('导入课件', () =>
                          beforeNative(async (c) => {
                            const result = await api.importSlides(c.id);
                            if (result) setToast(result.warnings.join('\n') || '课件已导入');
                          }),
                        )
                      }
                    >
                      <Upload size={15} />
                      导入课件
                    </Button>
                    <button
                      className="text-button"
                      onClick={() =>
                        void act('导入讲稿', () =>
                          beforeNative(async (c) => {
                            const result = await api.importScript(c.id);
                            if (result) setToast(result.warnings.join('\n') || '逐页讲稿已导入');
                          }),
                        )
                      }
                    >
                      从文件导入逐页讲稿
                    </button>
                    <ReplaceDeck
                      course={course}
                      disabled={dirty || !!busy}
                      saved={(c) => {
                        setCourse(c);
                        setDirty(false);
                        void refresh();
                      }}
                      error={setToast}
                    />
                  </div>
                </section>
                {slide ? (
                  <>
                    <section className="preview-panel">
                      <div className="preview-toolbar">
                        <div>
                          <span className="page-tag">第 {index + 1} 页</span>
                          <input
                            aria-label="页面标题"
                            value={slide.title}
                            onChange={(e) =>
                              updateSlide((s) => {
                                s.title = e.target.value;
                              })
                            }
                          />
                        </div>
                        <div className="preview-tools">
                          <button
                            className="icon-button"
                            title="上移页面"
                            disabled={index === 0}
                            onClick={() =>
                              update((c) => {
                                [c.slides[index - 1], c.slides[index]] = [
                                  c.slides[index],
                                  c.slides[index - 1],
                                ];
                              })
                            }
                          >
                            <ArrowUp size={16} />
                          </button>
                          <button
                            className="icon-button"
                            title="下移页面"
                            disabled={index === course.slides.length - 1}
                            onClick={() =>
                              update((c) => {
                                [c.slides[index + 1], c.slides[index]] = [
                                  c.slides[index],
                                  c.slides[index + 1],
                                ];
                              })
                            }
                          >
                            <ArrowDown size={16} />
                          </button>
                          <button
                            className="icon-button"
                            title="删除此页（保留素材历史）"
                            onClick={() =>
                              update((c) => {
                                c.slides = c.slides.filter((s) => s.id !== selectedId);
                              })
                            }
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>
                      <TimelineWorkspace
                        key={course.id}
                        course={course}
                        slide={slide}
                        selectPage={setSelectedId}
                        editLayout={tab === 'layout'}
                        enabled={!dialog && !colorPicker}
                        wide={wide}
                        toggleWide={() => setWide((v) => !v)}
                        update={update}
                        onMove={changeComposition}
                        onSampleColor={colorPicker && tab === 'layout' ? samplePreviewColor : undefined}
                      />
                      <div className="page-summary">
                        <div>
                          <MonitorPlay size={16} />
                          <span>{layoutNames[options!.layout]}</span>
                        </div>
                        <div>
                          <Mic size={15} />
                          <span>
                            {speechFor(course, slide).model.includes('plus')
                              ? 'Plus 增强配音'
                              : 'Flash 常规配音'}
                          </span>
                        </div>
                        <div>
                          <Clock3 size={15} />
                          <span>换页停顿 {slide.pagePauseMs}ms</span>
                        </div>
                      </div>
                      <section className="audio-section">
                        <div className="section-row">
                          <strong>
                            <Volume2 size={16} />
                            本页口播
                          </strong>
                          <button
                            className="text-button"
                            onClick={() =>
                              void act('导入真人录音', () =>
                                importAsset('audio', (c, asset) => {
                                  c.slides.find((s) => s.id === selectedId)!.recordedAudioId = asset;
                                }),
                              )
                            }
                          >
                            导入真人录音
                          </button>
                        </div>
                        {segmentsFor(slide).map((segment, i) => {
                          const audio = currentArtifact(course, slide, 'audio', segment);
                          return (
                            <div className="audio-segment" key={segment.id}>
                              <span className="segment-index">{i + 1}</span>
                              <p>{stripPauses(segment.text) || '真人录音'}</p>
                              {audio ? (
                                <Waveform url={api.mediaUrl(course.id, audio.assetId)} />
                              ) : (
                                <span className="muted">待生成</span>
                              )}
                              {!slide.recordedAudioId && (
                                <button
                                  className="icon-button"
                                  title="重新生成此段（下次提交会重新计费）"
                                  onClick={() =>
                                    updateSlide((s) => {
                                      const target = s.segments.find((n) => n.id === segment.id);
                                      if (target) target.take = (target.take ?? 0) + 1;
                                    })
                                  }
                                >
                                  <RefreshCw size={12} />
                                </button>
                              )}
                            </div>
                          );
                        })}
                        {!segmentsFor(slide).length && (
                          <div className="audio-empty">
                            <div className="wave-placeholder">
                              {Array.from({ length: 42 }, (_, i) => (
                                <i key={i} style={{ height: `${8 + ((i * 13) % 23)}px` }} />
                              ))}
                            </div>
                            <p>填写讲稿后，生成可试听的口播音频</p>
                          </div>
                        )}
                        <p className="subtle-note">
                          修改讲稿只更新受影响片段。音频确认后，再对齐人物口型与字幕。
                        </p>
                      </section>
                      <div className="preview-footer">
                        <Button
                          disabled={!artifact}
                          onClick={() =>
                            updateSlide((s) => {
                              s.reviewedFingerprint = slideFingerprint(course, s);
                              s.approvedSampleFingerprint = slideFingerprint(course, s);
                            })
                          }
                        >
                          <CheckCircle2 size={16} />
                          {slideStatus(course, slide) === 'approved' ? '已通过审核' : '确认本页样片'}
                        </Button>
                        <div>
                          <Button
                            disabled={!!busy}
                            onClick={() => {
                              setSampleId(undefined);
                              setDialog('generate');
                            }}
                          >
                            批量生成
                          </Button>
                          <Button
                            primary
                            disabled={!!busy}
                            onClick={() => {
                              setSampleId(slide.id);
                              setDialog('generate');
                            }}
                          >
                            <Sparkles size={16} />
                            {artifact ? '更新本页样片' : '生成本页样片'}
                          </Button>
                        </div>
                      </div>
                    </section>
                    <aside className="inspector">
                      <div className="tabs">
                        <button className={tab === 'script' ? 'active' : ''} onClick={() => setTab('script')}>
                          <FileText size={15} />
                          讲稿配音
                        </button>
                        <button className={tab === 'layout' ? 'active' : ''} onClick={() => setTab('layout')}>
                          <SlidersHorizontal size={15} />
                          画面设置
                        </button>
                        <button
                          className={tab === 'versions' ? 'active' : ''}
                          onClick={() => setTab('versions')}
                        >
                          版本
                        </button>
                      </div>
                      {tab === 'script' ? (
                        <div className="inspector-content">
                          <div className="section-row">
                            <strong>本页讲稿</strong>
                            <span className="muted">{stripPauses(slide.spokenText).length} 字</span>
                          </div>
                          <textarea
                            ref={scriptRef}
                            className="script-editor"
                            aria-label="本页讲稿"
                            placeholder="输入本页讲稿，或从 PPT 备注导入…"
                            value={slide.spokenText}
                            onChange={(e) =>
                              updateSlide((s) =>
                                Object.assign(s, updateNarration(s, e.target.value, s.subtitleText)),
                              )
                            }
                          />
                          <div className="script-tools">
                            <button
                              onClick={() => {
                                const at = scriptRef.current?.selectionStart ?? slide.spokenText.length;
                                updateSlide((s) =>
                                  Object.assign(
                                    s,
                                    updateNarration(
                                      s,
                                      s.spokenText.slice(0, at) + '[停顿500ms]' + s.spokenText.slice(at),
                                    ),
                                  ),
                                );
                              }}
                            >
                              <Pause size={13} />
                              插入气口
                            </button>
                            <button
                              onClick={() =>
                                updateSlide((s) => Object.assign(s, updateNarration(s, s.originalText)))
                              }
                            >
                              恢复原稿
                            </button>
                          </div>
                          <p className="subtle-note">用 [停顿500ms] 设置气口；字幕不会朗读该标记。</p>
                          <Field label="字幕文本" hint="留空时使用讲稿；修改字幕不改变朗读内容。">
                            <textarea
                              rows={3}
                              aria-label="字幕文本"
                              value={slide.subtitleText}
                              placeholder="按讲稿生成字幕"
                              onChange={(e) =>
                                updateSlide((s) =>
                                  Object.assign(s, updateNarration(s, s.spokenText, e.target.value)),
                                )
                              }
                            />
                          </Field>
                          <div className="inspector-divider" />
                          <h3>配音设置</h3>
                          <Field label="语音模型">
                            <select
                              value={speechFor(course, slide).model}
                              onChange={(e) =>
                                updateSlide((s) => {
                                  s.speechOverride = { ...s.speechOverride, model: e.target.value as any };
                                })
                              }
                            >
                              <option value="cosyvoice-v3.5-flash">CosyVoice Flash · 经济</option>
                              <option value="cosyvoice-v3.5-plus">CosyVoice Plus · 增强</option>
                            </select>
                          </Field>
                          <Field label={`语速　${speechFor(course, slide).speed.toFixed(2)}×`}>
                            <input
                              type="range"
                              min="0.5"
                              max="2"
                              step="0.05"
                              value={speechFor(course, slide).speed}
                              onChange={(e) =>
                                updateSlide((s) => {
                                  s.speechOverride = { ...s.speechOverride, speed: +e.target.value };
                                })
                              }
                            />
                            <div className="range-labels">
                              <span>舒缓 0.5×</span>
                              <span>自然 1.0×</span>
                              <span>紧凑 2.0×</span>
                            </div>
                          </Field>
                          <div className="two-fields">
                            <Field label="句间停顿 (ms)">
                              <input
                                type="number"
                                min={0}
                                max={10000}
                                step={50}
                                value={speechFor(course, slide).sentencePauseMs}
                                onChange={(e) =>
                                  updateSlide((s) => {
                                    s.speechOverride = {
                                      ...s.speechOverride,
                                      sentencePauseMs: +e.target.value,
                                    };
                                  })
                                }
                              />
                            </Field>
                            <Field label="换行气口 (ms)">
                              <input
                                type="number"
                                min={0}
                                max={10000}
                                step={50}
                                value={speechFor(course, slide).paragraphPauseMs}
                                onChange={(e) =>
                                  updateSlide((s) => {
                                    s.speechOverride = {
                                      ...s.speechOverride,
                                      paragraphPauseMs: Math.max(
                                        0,
                                        Math.min(10000, Math.round(+e.target.value)),
                                      ),
                                    };
                                  })
                                }
                              />
                            </Field>
                            <Field label="换页停顿 (ms)">
                              <input
                                type="number"
                                min={0}
                                max={10000}
                                step={50}
                                value={slide.pagePauseMs}
                                onChange={(e) =>
                                  updateSlide((s) => {
                                    s.pagePauseMs = +e.target.value;
                                  })
                                }
                              />
                            </Field>
                          </div>
                          <Button
                            onClick={() =>
                              update((c) => {
                                c.speech = speechFor(c, slide);
                                c.slides.forEach((s) => {
                                  delete s.speechOverride;
                                });
                              })
                            }
                          >
                            应用配音设置到全课
                          </Button>
                          {slide.recordedAudioId && (
                            <div className="notice">
                              <Mic size={16} />
                              本页使用真人录音
                              <Button
                                onClick={() =>
                                  updateSlide((s) => {
                                    delete s.recordedAudioId;
                                  })
                                }
                              >
                                移除
                              </Button>
                            </div>
                          )}
                          <div className="inspector-tip">
                            <WandSparkles size={17} />
                            <p>先试听一页样片，确认音色与节奏后再批量生成，可减少返工费用。</p>
                          </div>
                        </div>
                      ) : tab === 'layout' ? (
                        <div className="inspector-content">
                          <h3>页面版式</h3>
                          <div className="layout-options">
                            {presets(course).map((p) => (
                              <button
                                key={p.id}
                                className={
                                  (slide.layoutPresetId ?? options!.layout) === p.id ? 'selected' : ''
                                }
                                onClick={() => {
                                  setPresetName('');
                                  update((c) => {
                                    const current = c.slides.find((s) => s.id === selectedId)!;
                                    c.layoutPresets ??= [];
                                    if (!c.layoutPresets.some((entry) => entry.id === p.id))
                                      c.layoutPresets.push(structuredClone(p));
                                    current.layoutPresetId = p.id;
                                    delete current.compositionOverride;
                                  });
                                }}
                              >
                                {p.name}
                              </button>
                            ))}
                          </div>
                          <CanvasSettings
                            settings={options!}
                            hasDeck={!!slide.assetId && options!.layout !== 'presenter'}
                            change={changeComposition}
                            sampling={!!colorPicker}
                            toggleSampling={() =>
                              setColorPicker((current) => (current ? undefined : new AbortController()))
                            }
                            canSample={!isPreview}
                          />
                          <Field label="版式名称">
                            <input
                              maxLength={80}
                              value={presetName}
                              placeholder={
                                presets(course).find(
                                  (p) => p.id === (slide.layoutPresetId ?? options!.layout),
                                )?.name
                              }
                              onChange={(e) => setPresetName(e.target.value)}
                            />
                          </Field>
                          <div className="preset-actions">
                            {['保存版式', '另存为新版式', '删除自定义'].map((label, i) => (
                              <button
                                key={label}
                                disabled={
                                  !!busy ||
                                  (i === 2 && (!slide.layoutPresetId || slide.layoutPresetId in layoutNames))
                                }
                                onClick={() => {
                                  const key = slide.layoutPresetId ?? options!.layout;
                                  if (i === 1 && !presetName.trim()) {
                                    setToast('请输入新版式名称');
                                    return;
                                  }
                                  void act('保存版式', async () => {
                                    const c = structuredClone(course);
                                    const current = c.slides.find((s) => s.id === selectedId)!;
                                    if (i === 2) {
                                      for (const page of c.slides.filter((p) => p.layoutPresetId === key)) {
                                        page.compositionOverride = compositionFor(c, page);
                                        delete page.layoutPresetId;
                                      }
                                      c.layoutPresets = c.layoutPresets?.filter((p) => p.id !== key);
                                    } else {
                                      const id = i === 1 ? crypto.randomUUID() : key;
                                      const name =
                                        presetName.trim() || presets(c).find((p) => p.id === key)!.name;
                                      c.layoutPresets = [
                                        ...(c.layoutPresets ?? []).filter((p) => p.id !== id),
                                        { id, name, settings: { ...options! } },
                                      ];
                                      current.layoutPresetId = id;
                                      delete current.compositionOverride;
                                    }
                                    const saved = await api.saveCourse(c);
                                    setCourse(saved);
                                    courseRef.current = saved;
                                    dirtyRef.current = false;
                                    setDirty(false);
                                    setPresetName('');
                                    setToast('版式已保存到本课程。');
                                  });
                                }}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                          <Field label={'字幕底部留白 ' + (options!.subtitleBottom ?? 6.25) + '%'}>
                            <input
                              type="range"
                              min={0}
                              max={85}
                              step={0.25}
                              value={options!.subtitleBottom ?? 6.25}
                              onChange={(e) => changeComposition({ subtitleBottom: e.target.valueAsNumber })}
                            />
                          </Field>
                          <label className="check-field">
                            <input
                              type="checkbox"
                              checked={options!.burnSubtitles}
                              onChange={(e) =>
                                updateSlide((s) => {
                                  s.compositionOverride = {
                                    ...s.compositionOverride,
                                    burnSubtitles: e.target.checked,
                                  };
                                })
                              }
                            />
                            显示字幕
                          </label>
                          <Field label="整课页间淡出淡入（毫秒，0 为直接切换）">
                            <input
                              type="number"
                              min={0}
                              max={2000}
                              step={40}
                              value={course.transitionMs ?? 240}
                              onChange={(e) =>
                                update((c) => {
                                  c.transitionMs = Math.max(0, Math.min(2000, Math.round(+e.target.value)));
                                })
                              }
                            />
                          </Field>
                          <Field label="数字人生成路线">
                            <select
                              value={slide.videoModel ?? 'mediakit-lipsync'}
                              onChange={(e) =>
                                updateSlide((s) => {
                                  s.videoModel = e.target.value as any;
                                })
                              }
                            >
                              <option value="mediakit-lipsync">动作素材＋口型驱动</option>
                              <option value="omnihuman-1.5" disabled={!!slide.motionTrack?.length}>
                                图片直接驱动 · 高成本
                              </option>
                            </select>
                          </Field>
                          <Field label="页面动作模式">
                            <select
                              value={slide.motionId ?? ''}
                              onChange={(e) =>
                                updateSlide((s) => {
                                  s.motionId = e.target.value || undefined;
                                })
                              }
                            >
                              <option value="">动态待机＋本页动作轨道</option>
                              {course.speaker.motions
                                .filter((m) => m.reviewed && readyMotion(course, m))
                                .map((m) => (
                                  <option key={m.id} value={m.id} disabled={!!slide.motionTrack?.length}>
                                    整页 · {m.name}
                                  </option>
                                ))}
                            </select>
                          </Field>
                          <Field label={`人物大小 ${options!.presenterScale}%`}>
                            <input
                              type="range"
                              min={10}
                              max={70}
                              value={options!.presenterScale}
                              onChange={(e) =>
                                updateSlide((s) => {
                                  s.compositionOverride = {
                                    ...s.compositionOverride,
                                    presenterScale: +e.target.value,
                                  };
                                })
                              }
                            />
                          </Field>
                          <div className="two-fields">
                            <Field label="横向位置 %">
                              <input
                                type="number"
                                step="any"
                                value={options!.presenterX}
                                onChange={(e) =>
                                  updateSlide((s) => {
                                    s.compositionOverride = {
                                      ...s.compositionOverride,
                                      presenterX: +e.target.value,
                                    };
                                  })
                                }
                              />
                            </Field>
                            <Field label="纵向位置 %">
                              <input
                                type="number"
                                step="any"
                                value={options!.presenterY}
                                onChange={(e) =>
                                  updateSlide((s) => {
                                    s.compositionOverride = {
                                      ...s.compositionOverride,
                                      presenterY: +e.target.value,
                                    };
                                  })
                                }
                              />
                            </Field>
                          </div>
                          <button
                            className="text-button"
                            onClick={() =>
                              updateSlide((s) => {
                                s.compositionOverride = {
                                  ...s.compositionOverride,
                                  presenterX: 50,
                                  presenterY: 50,
                                };
                              })
                            }
                          >
                            将讲师移回画布中央
                          </button>
                          <Field label="字幕字号">
                            <input
                              type="number"
                              min={18}
                              max={72}
                              value={options!.subtitleSize}
                              onChange={(e) =>
                                updateSlide((s) => {
                                  s.compositionOverride = {
                                    ...s.compositionOverride,
                                    subtitleSize: +e.target.value,
                                  };
                                })
                              }
                            />
                          </Field>

                          <div className="two-fields">
                            <Button
                              onClick={() =>
                                void act('导入背景', () =>
                                  importAsset('image', (c, a) => {
                                    c.slides.find((s) => s.id === selectedId)!.backgroundAssetId = a;
                                  }),
                                )
                              }
                            >
                              <ImageIcon size={15} />
                              图片背景
                            </Button>
                            <Button
                              onClick={() =>
                                void act('导入视频', () =>
                                  importAsset('video', (c, a) => {
                                    c.slides.find((s) => s.id === selectedId)!.backgroundAssetId = a;
                                  }),
                                )
                              }
                            >
                              <Video size={15} />
                              视频背景
                            </Button>
                          </div>
                          {slide.backgroundAssetId && (
                            <>
                              <p className="file-name">
                                {course.assets.find((a) => a.id === slide.backgroundAssetId)?.name}
                              </p>
                              <Field label="视频起点（秒）">
                                <input
                                  type="number"
                                  min={0}
                                  value={slide.backgroundStartMs / 1000}
                                  onChange={(e) =>
                                    updateSlide((s) => {
                                      s.backgroundStartMs = +e.target.value * 1000;
                                    })
                                  }
                                />
                              </Field>
                              <Field label="背景不足时">
                                <select
                                  value={slide.shortBackground}
                                  onChange={(e) =>
                                    updateSlide((s) => {
                                      s.shortBackground = e.target.value as any;
                                    })
                                  }
                                >
                                  <option value="freeze">定格尾帧</option>
                                  <option value="loop">循环播放</option>
                                </select>
                              </Field>
                              <label className="check-field">
                                <input
                                  type="checkbox"
                                  checked={slide.keepBackgroundAudio}
                                  onChange={(e) =>
                                    updateSlide((s) => {
                                      s.keepBackgroundAudio = e.target.checked;
                                    })
                                  }
                                />
                                保留演示原声（需清空讲稿）
                              </label>
                              <button
                                className="text-button"
                                onClick={() =>
                                  updateSlide((s) => {
                                    delete s.backgroundAssetId;
                                    s.keepBackgroundAudio = false;
                                  })
                                }
                              >
                                移除背景
                              </button>
                            </>
                          )}
                          <Button
                            onClick={() =>
                              update((c) => {
                                c.composition = compositionFor(c, slide);
                                c.slides.forEach((s) => {
                                  delete s.layoutPresetId;
                                  delete s.compositionOverride;
                                });
                              })
                            }
                          >
                            应用画面设置到全课
                          </Button>
                        </div>
                      ) : (
                        <div className="inspector-content">
                          <History
                            course={course}
                            restored={(c) => {
                              setCourse(c);
                              setDirty(false);
                              setToast('已恢复历史版本');
                            }}
                            error={setToast}
                          />
                          <div className="inspector-divider" />
                          <Button onClick={() => setView('tasks')}>按生成批次管理与重试</Button>
                          <h3>未归组的旧版素材</h3>
                          {currentArtifact(course, slide, 'video') && (
                            <Button disabled={!!busy} onClick={() => {
                              setSampleId(slide.id);
                              setDialog('retake');
                            }}>按原素材清晰度重制本页人物</Button>
                          )}
                          <p className="subtle-note">
                            旧产物不会被覆盖。回到对应讲稿及设置时会自动复用；过期成片仅供比较。
                          </p>
                          {course.artifacts
                            .filter((a) => a.slideId === slide.id && !a.batchId)
                            .slice()
                            .reverse()
                            .map((a) => (
                              <div className="version" key={a.id}>
                                <b>
                                  {a.stage === 'audio' ? '配音' : a.stage === 'video' ? '人物' : '页面成片'}
                                </b>
                                <small>
                                  {new Date(a.createdAt).toLocaleString()} · {a.model}
                                </small>
                                {a.stage === 'audio' ? (
                                  <audio controls src={api.mediaUrl(course.id, a.assetId)} />
                                ) : (
                                  <video controls src={api.mediaUrl(course.id, a.assetId)} />
                                )}
                              </div>
                            ))}
                          {!course.artifacts.some((a) => a.slideId === slide.id && !a.batchId) && (
                            <p className="muted">本页没有未归组的旧版素材。</p>
                          )}
                        </div>
                      )}
                    </aside>
                  </>
                ) : (
                  <div className="no-slide">
                    <Empty
                      icon={<Layers3 size={40} />}
                      title="导入你的课程资料"
                      text="每页课件独立编辑和生成。支持读取 PPT 备注作为讲稿。"
                    >
                      <Button
                        primary
                        onClick={() =>
                          void act('导入课件', () =>
                            beforeNative(async (c) => {
                              const result = await api.importSlides(c.id);
                              if (result) setToast(result.warnings.join('\n'));
                            }),
                          )
                        }
                      >
                        <Upload size={16} />
                        选择课件
                      </Button>
                      <Button
                        onClick={() =>
                          update((c) => {
                            const s = newSlide('课程导入');
                            c.slides.push(s);
                            setSelectedId(s.id);
                          })
                        }
                      >
                        添加空白页
                      </Button>
                    </Empty>
                  </div>
                )}
              </div>
            )}
          </>
        )}
        {view !== 'editor' && (
          <section className="secondary-page">
            <div className="page-heading">
              <div>
                <div className="eyebrow">MOOC STUDIO / WORKSPACE</div>
                <h1>{view === 'settings' ? '设置与连接' : nav.find((n) => n.key === view)?.title}</h1>
                <p>
                  {view === 'speaker'
                    ? '一次建立档案，让每堂课都保持熟悉的声音与形象。'
                    : view === 'motions'
                      ? '从讲师的人物动作视频中选段，将首尾衔接后的动作加入课程。'
                      : view === 'tasks'
                        ? '查看生成进度，恢复中断任务，保留每一次完成的素材。'
                        : view === 'billing'
                          ? '先看费用，再开始生成。每一笔用量都有记录。'
                          : '本地工具与境内云服务，按需连接。'}
                </p>
              </div>
              {course && dirty && (
                <Button primary onClick={() => void act('保存', save)}>
                  <Save size={15} />
                  保存更改
                </Button>
              )}
            </div>
            {(view === 'speaker' || view === 'motions') && !course && (
              <Empty
                icon={<UserRound size={36} />}
                title="先建立一个课程工程"
                text="讲师档案与动作素材会随工程一起保存。"
              >
                <Button primary onClick={() => setDialog('create')}>
                  新建课程
                </Button>
              </Empty>
            )}
            {view === 'speaker' && course && (
              <div className="settings-grid lecturer-grid">
                <section className="card lecturer-assets">
                  <h2>讲师资料</h2>
                  <SpeakerLibrary
                    course={course}
                    disabled={dirty || !!busy}
                    loaded={(c) => {
                      setCourse(c);
                      setDirty(false);
                    }}
                    error={setToast}
                  />
                  <Field label="讲师名称">
                    <input
                      value={course.speaker.name}
                      onChange={(e) =>
                        update((c) => {
                          c.speaker.name = e.target.value;
                        })
                      }
                    />
                  </Field>
                  <div className="lecturer-media">
                    {(
                      [
                        {
                          key: 'imageAssetId',
                          kind: 'image',
                          name: '人物照片',
                          hint: '导入后使用火山 MediaKit 人像抠图',
                          icon: <ImageIcon />,
                        },
                        {
                          key: 'videoAssetId',
                          kind: 'video',
                          name: '人物动作视频',
                          hint: '最长 5 分钟。透明背景视频导入后即可剪辑。',
                          icon: <Video />,
                        },
                        {
                          key: 'idleAssetId',
                          kind: 'video',
                          name: '动态待机视频',
                          hint: '选择眨眼、呼吸等自然小动作，首尾姿态相近的循环镜头。',
                          icon: <Video />,
                        },
                        {
                          key: 'voiceAssetId',
                          kind: 'audio',
                          name: '音色参考',
                          hint: '建议 10–20 秒清晰单人录音',
                          icon: <Mic />,
                        },
                      ] as const
                    ).map((slot) => {
                      const asset = course.assets.find((a) => a.id === course.speaker[slot.key]);
                      return (
                        <section className={'media-tile ' + slot.kind} key={slot.key}>
                          <header>
                            {slot.icon}
                            <h3>{slot.name}</h3>
                          </header>
                          <div className="media-source">
                            {asset ? (
                              slot.kind === 'image' ? (
                                <img alt="讲师形象" src={api.mediaUrl(course.id, asset.id)} />
                              ) : slot.kind === 'video' ? (
                                <video
                                  className="alpha-preview"
                                  controls
                                  loop={slot.key === 'idleAssetId'}
                                  preload="metadata"
                                  src={api.mediaUrl(course.id, asset.id)}
                                />
                              ) : (
                                <audio controls preload="metadata" src={api.mediaUrl(course.id, asset.id)} />
                              )
                            ) : (
                              slot.icon
                            )}
                          </div>
                          <small title={asset?.name}>{asset?.name ?? slot.hint}</small>
                          {asset && <OpenMediaLocation courseId={course.id} id={asset.id} />}
                          {slot.kind === 'image' && course.speaker.originalPortraitId && course.speaker.originalPortraitId !== asset?.id && (
                            <OpenMediaLocation courseId={course.id} id={course.speaker.originalPortraitId} label="打开原照保存位置" />
                          )}
                          {slot.kind === 'image' && <small>导入或重新抠图将上传原照，成功按张计费。</small>}
                          {slot.kind === 'video' && (
                            <small>
                              {asset
                                ? asset.info.transparent ? '已识别透明背景，可直接使用。' : '已保存在本地。移除背景后可用于透明人物合成。'
                                : '仅导入本地文件。如需云端抠像，可在导入后单独选择。'}
                            </small>
                          )}
                          <Button
                            disabled={!!busy}
                            onClick={() =>
                              void act('导入' + slot.name, () =>
                                beforeNative(async (c) => {
                                  const r = await api.importAsset(c.id, slot.kind);
                                  if (!r) return;
                                  if (slot.kind === 'video') {
                                    await api.importActorVideo(
                                      c.id,
                                      r.asset.id,
                                      slot.key === 'idleAssetId' ? 'idle' : 'reference',
                                    );
                                    return;
                                  }
                                  r.course.speaker[slot.key] = r.asset.id;
                                  if (slot.kind === 'image') r.course.speaker.originalPortraitId = r.asset.id;
                                  await api.saveCourse(r.course);
                                  if (slot.kind === 'image') await api.cutPortrait(c.id, r.asset.id);
                                }),
                              )
                            }
                          >
                            {asset ? '更换' : '导入'}
                            {slot.name}
                          </Button>
                          {slot.key === 'idleAssetId' && (
                            <button
                              className="text-button"
                              disabled={
                                !!busy ||
                                !course.speaker.imageAssetId ||
                                !course.assets.find(
                                  (a) => a.id === (course.speaker.idleAssetId ?? course.speaker.videoAssetId),
                                )?.info.transparent
                              }
                              onClick={() => {
                                if (
                                  window.confirm(
                                    '用讲师照片复现当前待机参考的动作。生成和抠像预算上限 ' +
                                    money(motionCutSpec(120, course.assets.find(a => a.id ===
                                      (course.speaker.idleAssetId ?? course.speaker.videoAssetId))?.info).budgetMicros) + '。',
                                  )
                                )
                                  void act('生成动态待机', () =>
                                    beforeNative(async (c) => {
                                      await api.generateIdle(c.id);
                                    }),
                                  );
                              }}
                            >
                              用照片与参考生成待机
                            </button>
                          )}
                          {asset && slot.kind === 'image' && (
                            <button
                              className="text-button"
                              onClick={() =>
                                void act('抠图', () =>
                                  beforeNative(async (c) => {
                                    await api.cutPortrait(c.id, c.speaker.originalPortraitId ?? asset.id);
                                  }),
                                )
                              }
                            >
                              MediaKit 重新抠图
                            </button>
                          )}
                          {asset && slot.kind === 'video' && !asset.info.transparent && (
                            <button
                              className="text-button"
                              disabled={!!busy}
                              onClick={() => {
                                const cost = matteCost((asset.info.durationMs ?? 0) + 40, asset.info);
                                if (!window.confirm(
                                  '将「' + asset.name + '」上传至火山 MediaKit 移除背景？预计费用上限 ' + money(cost) + '。',
                                )) return;
                                void act('视频抠像', () =>
                                  beforeNative(async (c) => {
                                    if (c.speaker[slot.key] !== asset.id) throw new Error('人物视频已更换，请重试。');
                                    await api.prepareActorVideo(c.id, asset.id, slot.key === 'idleAssetId' ? 'idle' : 'reference');
                                  }),
                                );
                              }}
                            >
                              移除视频背景
                            </button>
                          )}
                          {asset && asset.info.transparent && slot.key === 'videoAssetId' && (
                            <button
                              className="text-button"
                              disabled={!!busy}
                              onClick={() => setView('motions')}
                            >
                              去动作素材剪辑 <ArrowRight size={13} />
                            </button>
                          )}
                        </section>
                      );
                    })}
                  </div>
                </section>
                <section className="card voice-studio">
                  <h2>专属音色</h2>
                  <Field label="复刻模型">
                    <select
                      value={course.speech.model}
                      onChange={(e) =>
                        update((c) => {
                          c.speech.model = e.target.value as any;
                        })
                      }
                    >
                      <option value="cosyvoice-v3.5-flash">CosyVoice Flash</option>
                      <option value="cosyvoice-v3.5-plus">CosyVoice Plus</option>
                    </select>
                  </Field>
                  <Field label="可用音色">
                    <select
                      value={course.speaker.voiceIds[course.speech.model] ?? ''}
                      disabled={!state?.account}
                      onChange={(e) => {
                        const id = e.target.value;
                        void act('切换音色', () =>
                          beforeNative(async (c) => {
                            await api.selectVoice(c.id, id);
                          }),
                        );
                      }}
                    >
                      <option value="" disabled>
                        选择本账号已创建的音色
                      </option>
                      {course.speaker.voiceIds[course.speech.model] &&
                        !voiceList.some((v) => v.id === course.speaker.voiceIds[course.speech.model]) && (
                          <option value={course.speaker.voiceIds[course.speech.model]}>当前讲师音色</option>
                        )}
                      {voiceList
                        .filter((v) => v.model === course.speech.model)
                        .map((v) => (
                          <option key={v.id} value={v.id}>
                            {new Date(v.created_at).toLocaleString()} · {v.id.slice(-8)}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Button
                    disabled={!course.speaker.voiceIds[course.speech.model] || !!busy}
                    onClick={() =>
                      void act('生成音色试听', () =>
                        beforeNative(async (c) => {
                          const asset = await api.previewVoice(c.id);
                          setAudition({ course: c.id, asset, voice: c.speaker.voiceIds[c.speech.model]! });
                        }),
                      )
                    }
                  >
                    试听当前音色
                  </Button>
                  <p className="subtle-note">
                    试听句「大家好，欢迎来到今天的课程。」首次按短句配音计费，之后可重复播放。
                  </p>
                  {auditionAsset && <>
                    <audio controls autoPlay={!!activeAudition} src={api.mediaUrl(course.id, auditionAsset)} />
                    <OpenMediaLocation courseId={course.id} id={auditionAsset} label="打开试听文件保存位置" />
                  </>}
                  <Button
                    primary
                    onClick={() =>
                      void act('复刻音色', () =>
                        beforeNative(async (c) => {
                          await api.cloneVoice(c.id);
                          setToast('音色复刻完成');
                        }),
                      )
                    }
                  >
                    <Volume2 size={16} />
                    创建专属音色
                  </Button>
                  <Button
                    onClick={() =>
                      void act('删除云端音色', () =>
                        beforeNative(async (c) => {
                          await api.deleteVoices(c.id);
                        }),
                      )
                    }
                  >
                    删除云端音色
                  </Button>
                </section>
                <section className="card">
                  <h2>发音词典</h2>
                  <p className="subtle-note">每行一条：原词=读法。应用到全课，仍保留字幕原文。</p>
                  <textarea
                    rows={4}
                    value={
                      dictionaryText || course.speech.dictionary.map((d) => `${d.text}=${d.alias}`).join('\n')
                    }
                    onChange={(e) => setDictionaryText(e.target.value)}
                    placeholder={'重庆=重庆\nAI=人工智能'}
                  />
                  <Button
                    onClick={() => {
                      update((c) => {
                        c.speech.dictionary = dictionaryText
                          .split('\n')
                          .map((line) => line.split('='))
                          .filter((a) => a.length === 2 && a[0].trim() && a[1].trim())
                          .map(([text, alias]) => ({ text: text.trim(), alias: alias.trim() }));
                      });
                      setToast('词典已更新，请保存。');
                    }}
                  >
                    应用词典
                  </Button>
                </section>
              </div>
            )}
            {view === 'motions' && course && (
              <MotionWorkspace
                key={course.id}
                course={course}
                accountId={state.account?.id}
                cloudUrl={state.settings.cloudUrl}
                busy={busy ?? ''}
                run={(label, operation) => act(label, () => beforeNative(operation))}
                goTo={setView}
              />
            )}
            {view === 'tasks' && (
              <>
                {course && <ProductionHistory key={course.id} course={course} disabled={!!busy || currentTasks.some(t => t.status === 'running')}
                  submit={async request => {
                    await beforeNative(async c => {
                      if (c.id !== request.courseId) throw new Error('当前课程已更换。');
                      await api.produce(request);
                      setToast('已提交本页，可在生成批次中查看进度。');
                    });
                  }} />}
                {state.account && <details className="card"><summary>云端任务明细与结果恢复（当前账号）</summary>
                  <CloudTasks
                    course={course}
                    disabled={dirty || !!busy}
                    recovered={(c) => {
                      setCourse(c);
                      setDirty(false);
                      void refresh();
                    }}
                  />
                </details>}
                {state.tasks.length ? (
                  <div className="task-list">
                    {state.tasks.map((t) => (
                      <div className="card task" key={t.id}>
                        <div className="section-row">
                          <h3>{t.label}</h3>
                          <span className={`pill ${t.status}`}>
                            {
                              {
                                running: '处理中',
                                completed: '已完成',
                                failed: '需处理',
                                cancelled: '已停止',
                              }[t.status]
                            }
                          </span>
                        </div>
                        <p>{state.courses.find((c) => c.id === t.courseId)?.title}</p>
                        <div className="progress">
                          <i style={{ width: `${t.progress}%` }} />
                        </div>
                        <pre>{t.message}</pre>
                        <div className="section-row">
                          <small className="muted">{new Date(t.createdAt).toLocaleString()}</small>
                          {t.status === 'running' ? (
                            <Button onClick={() => void act('停止任务', async () => api.stopTask(t.id))}>
                              停止后续生成
                            </Button>
                          ) : (
                            <Button
                              onClick={() => {
                                setCourse(state.courses.find((c) => c.id === t.courseId));
                                setView('editor');
                              }}
                            >
                              返回课程检查
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Empty
                    icon={<ListChecks size={40} />}
                    title="暂时没有制作任务"
                    text="从课程中生成一页样片，任务会在这里显示。"
                  />
                )}
              </>
            )}
            {view === 'billing' && (
              <>
                {!state.account ? (
                  <Empty
                    icon={<Wallet size={38} />}
                    title="登录后查看机构额度"
                    text="云服务按成功任务结算；技术失败退还冻结额度。"
                  >
                    <Button primary onClick={() => setView('settings')}>
                      连接云服务
                    </Button>
                  </Empty>
                ) : overview ? (
                  <>
                    <div className="wallet-cards">
                      <div className="card">
                        <span>可用额度</span>
                        <strong>{money(overview.wallet.availableMicros)}</strong>
                        <small>可用于新的生成任务</small>
                      </div>
                      <div className="card">
                        <span>冻结额度</span>
                        <strong>{money(overview.wallet.frozenMicros)}</strong>
                        <small>等待正在执行的任务结算</small>
                      </div>
                      <div className="card">
                        <span>累计用量</span>
                        <strong>{money(overview.wallet.spentMicros)}</strong>
                        <small>仅统计成功交付的任务</small>
                      </div>
                    </div>
                    <section className="card">
                      <div className="section-row">
                        <h2>模型目录</h2>
                        <Button
                          onClick={() => void act('刷新', async () => setOverview(await api.cloudOverview()))}
                        >
                          <RefreshCw size={14} />
                          刷新
                        </Button>
                      </div>
                      <table>
                        <thead>
                          <tr>
                            <th>模型</th>
                            <th>参考价格</th>
                            <th>状态</th>
                          </tr>
                        </thead>
                        <tbody>
                          {overview.models.map((m) => (
                            <tr key={m.id}>
                              <td>{m.name}</td>
                              <td>
                                {money(m.priceMicros)} / {m.unit}
                              </td>
                              <td>
                                <span className={`pill ${m.available ? 'completed' : ''}`}>
                                  {m.available ? '可用' : m.reason}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </section>
                    {state.account.role === 'admin' && (
                      <section className="card admin-form">
                        <h2>试点额度管理</h2>
                        <Field label="同机构用户邮箱">
                          <input value={email} onChange={(e) => setEmail(e.target.value)} />
                        </Field>
                        <Field label="增加机构额度（元）">
                          <input
                            type="number"
                            min={1}
                            value={grantAmount}
                            onChange={(e) => setGrantAmount(+e.target.value)}
                          />
                        </Field>
                        <Button
                          onClick={() =>
                            void act('增加额度', async () => {
                              await api.grant(email, Math.round(grantAmount * 1000000), id());
                              setOverview(await api.cloudOverview());
                            })
                          }
                        >
                          增加额度
                        </Button>
                      </section>
                    )}
                    <section className="card">
                      <div className="section-row">
                        <h2>用量记录</h2>
                        <Button
                          onClick={() =>
                            void act('导出账单', async () => {
                              const file = await api.exportLedger();
                              if (file) await api.openExport(file);
                            })
                          }
                        >
                          导出完整账单 CSV
                        </Button>
                      </div>
                      <table>
                        <thead>
                          <tr>
                            <th>时间</th>
                            <th>类型</th>
                            <th>金额</th>
                            <th>说明</th>
                          </tr>
                        </thead>
                        <tbody>
                          {overview.ledger.map((l) => (
                            <tr key={l.id}>
                              <td>{new Date(l.createdAt).toLocaleString()}</td>
                              <td>
                                {{ grant: '增加', freeze: '冻结', settle: '结算', release: '退回' }[l.type]}
                              </td>
                              <td>{money(l.amountMicros)}</td>
                              <td>{l.description}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!overview.ledger.length && <p className="muted">暂无用量记录</p>}
                    </section>
                  </>
                ) : (
                  <p>正在加载账单…</p>
                )}
              </>
            )}
            {view === 'settings' && settings && (
              <div className="settings-grid">
                <section className="card">
                  <h2>本地处理工具</h2>
                  <p className="subtle-note">不要求独立显卡。请选择你已安装的工具；原文件不会被覆盖。</p>
                  {(['ffmpegPath', 'ffprobePath', 'sofficePath'] as const).map((field, i) => (
                    <Field
                      key={field}
                      label={['FFmpeg 可执行文件', 'FFprobe 可执行文件', 'LibreOffice（可选）'][i]}
                    >
                      <input
                        value={settings[field]}
                        onChange={(e) => setSettings({ ...settings, [field]: e.target.value })}
                        placeholder={
                          [
                            'C:\\tools\\ffmpeg.exe',
                            'C:\\tools\\ffprobe.exe',
                            'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
                          ][i]
                        }
                      />
                    </Field>
                  ))}
                  <div className="capabilities">
                    {[
                      ['FFmpeg', state.capabilities.ffmpeg],
                      ['FFprobe', state.capabilities.ffprobe],
                      ['PowerPoint', state.capabilities.powerpoint],
                      ['LibreOffice', state.capabilities.libreoffice],
                    ].map(([label, available]) => (
                      <span key={String(label)} className={available ? 'ok' : ''}>
                        {available ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />} {label}
                      </span>
                    ))}
                  </div>
                  <p className="file-name">工程位置：{state.capabilities.dataDirectory}</p>
                  <Button
                    primary
                    onClick={() =>
                      void act('保存设置', async () => {
                        await api.saveSettings(settings);
                        await refresh();
                        setToast('工具设置已保存并检查');
                      })
                    }
                  >
                    保存并检查
                  </Button>
                  <Button
                    onClick={() =>
                      void act('恢复工程', async () => {
                        const c = await api.restoreProject();
                        if (c) {
                          await refresh();
                          setCourse(c);
                          setView('editor');
                        }
                      })
                    }
                  >
                    恢复工程包
                  </Button>
                </section>
                <section className="card">
                  <h2>云端账号</h2>
                  <Field label="服务地址">
                    <input
                      value={settings.cloudUrl}
                      onChange={(e) => setSettings({ ...settings, cloudUrl: e.target.value })}
                    />
                  </Field>
                  <p className="subtle-note">供应商密钥只配置在服务端。此处连接你部署的慕课云服务。</p>
                  <Button
                    onClick={() =>
                      void act('保存服务地址', async () => {
                        await api.saveSettings(settings);
                        await refresh();
                      })
                    }
                  >
                    保存服务地址
                  </Button>
                  {state.account ? (
                    <div className="notice">
                      <UserRound size={20} />
                      <span>{state.account.email}</span>
                      <button
                        className="text-button"
                        onClick={() =>
                          void act('退出登录', async () => {
                            await api.logout();
                            await refresh();
                          })
                        }
                      >
                        <LogOut size={14} />
                        退出
                      </button>
                    </div>
                  ) : (
                    <>
                      <Field label="邮箱">
                        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                      </Field>
                      <Field label="密码">
                        <input
                          type="password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                        />
                      </Field>
                      <Button
                        primary
                        disabled={!!busy}
                        onClick={() =>
                          void act('登录', async () => {
                            await api.saveSettings(settings);
                            await api.login(email, password);
                            setPassword('');
                            await refresh();
                            setToast('已连接机构云服务');
                          })
                        }
                      >
                        登录工作区
                      </Button>
                    </>
                  )}
                  {state.account?.role === 'admin' && (
                    <>
                      <div className="inspector-divider" />
                      <h3>添加机构作者</h3>
                      <Field label="新作者邮箱">
                        <input value={email} onChange={(e) => setEmail(e.target.value)} />
                      </Field>
                      <Field label="初始密码（至少 12 位）">
                        <input
                          type="password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                        />
                      </Field>
                      <Button
                        onClick={() =>
                          void act('创建作者', async () => {
                            await api.createAuthor(email, password);
                            setPassword('');
                            setToast('作者账号已创建');
                          })
                        }
                      >
                        创建作者账号
                      </Button>
                    </>
                  )}
                </section>
              </div>
            )}
          </section>
        )}
        <footer className="app-footer">
          <span>
            <ShieldCheck size={13} />
            原稿保留 · 版本可追溯 · 按页返修
          </span>
          <span>
            {currentTasks.find((t) => t.status === 'running')?.message ?? '准备就绪'} <i /> v0.1.0
          </span>
        </footer>
      </main>
      {busy && (
        <div className="busy-indicator">
          <LoaderCircle className="spin" size={16} />
          {busy}…
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <AlertCircle size={18} />
          <span>{toast}</span>
          <button onClick={() => setToast('')} aria-label="关闭提示">
            <X size={16} />
          </button>
        </div>
      )}
      {dialog === 'create' && (
        <Modal title="新建课程" close={() => setDialog(null)}>
          <Field label="课程名称">
            <input
              autoFocus
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="例如：数字素养与人工智能基础"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newTitle.trim())
                  void act('创建课程', async () => {
                    if (dirty) await save();
                    const c = await api.createCourse(newTitle.trim());
                    await refresh();
                    setCourse(c);
                    setDirty(false);
                    setDialog(null);
                    setNewTitle('');
                    setView('editor');
                  });
              }}
            />
          </Field>
          <p className="subtle-note">课程按页保存。之后可以导入 PPT、PDF、图片与逐页讲稿。</p>
          <div className="modal-actions">
            <Button onClick={() => setDialog(null)}>取消</Button>
            <Button
              primary
              disabled={!newTitle.trim() || !!busy}
              onClick={() =>
                void act('创建课程', async () => {
                  if (dirty) await save();
                  const c = await api.createCourse(newTitle.trim());
                  await refresh();
                  setCourse(c);
                  setDialog(null);
                  setNewTitle('');
                  setView('editor');
                })
              }
            >
              创建课程
              <ArrowRight size={15} />
            </Button>
          </div>
        </Modal>
      )}
      {(dialog === 'generate' || dialog === 'retake') && productionCourse && productionPages && estimate && (
        <Modal title={sample ? '生成一页完整样片' : '批量生成课程'} close={() => setDialog(null)}>
          <div className="notice">
            <Sparkles size={18} />
            <div>
              <b>
                {sample && productionPages.length > 0
                  ? `第 ${productionCourse.slides.indexOf(productionPages[0]) + 1} 页 · ${productionPages[0].title}`
                  : `${productionPages.length} 个页面`}
              </b>
              <p>复用已有有效素材，只生成受影响的片段。实际时长确认后由服务端报价。</p>
            </div>
          </div>
          <Field label="本次新增费用上限（元）">
            <input type="number" min={0} value={budget} onChange={(e) => setBudget(+e.target.value)} />
          </Field>
          <div className="cost-details">
            <span>配音 / 人物生成及视频抠像</span>
            <b>
              {money(estimate.audioMicros)} / {money(estimate.videoMicros)}
            </b>
          </div>
          <div className="cost-details">
            <span>本次预计新增</span>
            <b>{money(estimate.totalMicros)}</b>
          </div>
          <p className="subtle-note">
            可复用：{estimate.reusedPages} 页成片、{estimate.reusedAudio} 段音频、{estimate.reusedVideo}{' '}
            段人物视频。人物费用按确认后的音频时长计算，预算不足时停止新增提交。
          </p>
          {estimate.cloudJobs === 0 && (
            <p className="subtle-note">本次使用本地录音或已有素材，无需上传或调用模型。</p>
          )}
          <div className="modal-actions">
            <Button onClick={() => setDialog(null)}>返回编辑</Button>
            <Button
              primary
              disabled={!!busy || !productionPages.length}
              onClick={() =>
                void act('提交任务', async () => {
                  const saved = await api.saveCourse(productionCourse);
                  setCourse(saved);
                  setDirty(false);
                  await api.produce({
                    courseId: saved.id,
                    slideIds: productionPages.map((s) => s.id),
                    budgetMicros: Math.round(budget * 1000000),
                    sample,
                  });
                  setDialog(null);
                  setToast('任务已创建，可在制作任务中查看进度。');
                  await refresh();
                })
              }
            >
              <Sparkles size={15} />
              确认预算并生成
            </Button>
          </div>
        </Modal>
      )}
      {dialog === 'export' && course && (
        <Modal title="导出课程" close={() => setDialog(null)}>
          <div className="export-spec">
            <MonitorPlay size={28} />
            <div>
              <b>MP4 · 1920 × 1080 · 25fps</b>
              <p>H.264 视频 / AAC 音频 · 保留 AI 内容标识</p>
            </div>
          </div>
          {(
            [
              { key: 'subtitles', title: '字幕烧录到成片', text: 'SRT 字幕文件始终同时导出' },
              { key: 'audio', title: '完整口播音频', text: '48kHz WAV，可用于其他课程平台' },
              { key: 'perSlide', title: '逐页视频', text: '便于后续外部剪辑和局部替换' },
              { key: 'project', title: '可迁移工程包', text: '包含素材和设置，不包含登录凭据' },
            ] as const
          ).map((o) => (
            <label className="export-option" key={o.key}>
              <input
                type="checkbox"
                checked={exportOptions[o.key]}
                onChange={(e) => setExportOptions({ ...exportOptions, [o.key]: e.target.checked })}
              />
              <span>
                <b>{o.title}</b>
                <small>{o.text}</small>
              </span>
            </label>
          ))}
          <p className="subtle-note">
            正式导出前需完成逐页审核。字幕按音频段落对齐，段内时间为估算，需试听核对。
          </p>
          <div className="modal-actions">
            <Button onClick={() => setDialog(null)}>取消</Button>
            <Button
              primary
              disabled={!!busy}
              onClick={() =>
                void act('导出课程', () =>
                  beforeNative(async (c) => {
                    const file = await api.exportCourse(c.id, exportOptions);
                    if (file) {
                      setDialog(null);
                      setToast('课程已导出');
                      await api.openExport(file);
                    }
                  }),
                )
              }
            >
              <Download size={15} />
              选择位置并导出
            </Button>
          </div>
        </Modal>
      )}
      {dialog === 'help' && (
        <Modal title="从课件到一堂完整的课" close={() => setDialog(null)}>
          <ol className="guide">
            <li>
              <b>导入课件与讲稿</b>
              <p>每页对应一段讲稿。可从 PPT 备注读取，或导入以“第 1 页”独占一行分隔的文档。</p>
            </li>
            <li>
              <b>建立讲师档案</b>
              <p>上传照片、人物视频和清晰的参考声音。没有云服务时，可先导入真人录音制作纯课件视频。</p>
            </li>
            <li>
              <b>调整气口，先做样片</b>
              <p>用 [停顿500ms] 插入停顿，设置读法、语速与版式，生成并确认一页完整样片。</p>
            </li>
            <li>
              <b>批量生成与逐页检查</b>
              <p>出现问题时只修改对应页面。旧产物保留，新版本单独生成。</p>
            </li>
            <li>
              <b>审核后导出</b>
              <p>导出成片、字幕、口播音频及工程包。首次正式使用模型前，需要真实素材验收。</p>
            </li>
          </ol>
          <Button primary onClick={() => setDialog(null)}>
            开始制作
          </Button>
        </Modal>
      )}
    </div>
  );
}
