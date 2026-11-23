import { useState } from 'react';
import { batchCourse, outputLabels, pageOutputs, repairSlide } from '../shared/production-batches';
import { slideFingerprint } from '../shared/domain';
import { estimateProduction } from '../shared/estimate';
import type { Course, PageOperation, ProductionRequest, Slide } from '../shared/types';
import { OpenMediaLocation } from './OpenMediaLocation';
import { api } from './api';
import './production-history.css';

export function ProductionHistory({
  course,
  disabled,
  submit,
}: {
  course: Course;
  disabled: boolean;
  submit: (request: ProductionRequest) => Promise<void>;
}) {
  const [scope, setScope] = useState('');
  const [expanded, setExpanded] = useState('');
  const [filter, setFilter] = useState('all');
  const [order, setOrder] = useState<{ id: string; operation: PageOperation; recordingId?: string }>();
  const [limit, setLimit] = useState('1');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const batches = course.batches ?? [];
  const batch = batches.find((b) => b.id === scope);
  const source = batch ? batchCourse(course, batch) : course;
  const selected = source.slides.find((s) => s.id === order?.id);
  const page = batch?.pages.find((p) => p.slide.id === order?.id);
  const pricingSlide =
    selected && page && order ? repairSlide(page, order.operation, Date.now(), order.recordingId) : selected;
  const estimate =
    pricingSlide &&
    estimateProduction(
      source,
      [pricingSlide],
      order?.operation === 'resume' ? batch?.mode : order?.operation,
    );
  const estimateMicros = order?.operation === 'audio' ? estimate?.audioMicros : estimate?.totalMicros;
  const operationName = { resume: '继续生成本页', audio: '仅重做配音', video: '重做人物视频并合成' };

  function prepare(slide: Slide, operation: PageOperation, recordingId?: string) {
    const existing =
      batch ??
      [...batches].reverse().find((b) => {
        const p = b.pages.find((p) => p.slide.id === slide.id);
        return (
          p && slideFingerprint({ ...course, ...b.settings }, p.slide) === slideFingerprint(course, slide)
        );
      });
    const record = existing?.pages.find((p) => p.slide.id === slide.id);
    const context = existing ? batchCourse(course, existing) : source;
    if (existing) setScope(existing.id);
    const quote = estimateProduction(
      context,
      [record ? repairSlide(record, operation, Date.now(), recordingId) : slide],
      operation === 'resume' ? existing?.mode : operation,
    );
    const amount = operation === 'audio' ? quote.audioMicros : quote.totalMicros;
    setLimit(String(Math.ceil(amount / 10000) / 100));
    setOrder({ id: slide.id, operation, recordingId });
    setError('');
  }
  async function pickRecording(slide: Slide) {
    setSending(true);
    try {
      const result = await api.importAsset(course.id, 'audio');
      if (result) prepare(slide, 'audio', result.asset.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }
  async function confirm() {
    if (!order || sending) return;
    setSending(true);
    try {
      await submit({
        courseId: course.id,
        slideIds: [order.id],
        budgetMicros: Math.round(Number(limit) * 1e6),
        sample: true,
        batchId: batch?.id,
        operation: batch ? order.operation : undefined,
        recordingId: order.recordingId,
      });
      setOrder(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }
  return (
    <section className="card production-history">
      <h2>逐页产物与生成批次</h2>
      <div className="batch-tools">
        <label>
          查看范围
          <select
            value={scope}
            onChange={(e) => {
              setScope(e.target.value);
              setOrder(undefined);
              setExpanded('');
              setError('');
            }}
          >
            <option value="">当前课程 · 全部页面</option>
            {batches
              .map((b, i) => (
                <option key={b.id} value={b.id}>
                  第 {i + 1} 批 · {b.label} · {new Date(b.createdAt).toLocaleString()} · {b.pages.length} 页
                </option>
              ))
              .reverse()}
          </select>
        </label>
        <label>
          筛选
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">全部状态</option>
            <option value="incomplete">缺少成片 / 需重做</option>
            <option value="complete">已有成片</option>
            <option value="audio">已有配音</option>
            <option value="video">已有人物视频</option>
          </select>
        </label>
      </div>
      {source.slides.length === 0 && <p>当前课程还没有页面。</p>}
      {source.slides.map((slide, i) => {
        const record = batch?.pages[i];
        const outputs = pageOutputs(source, slide);
        if (
          (filter === 'complete' && !outputs.composition) ||
          (filter === 'incomplete' && outputs.composition) ||
          (filter === 'audio' &&
            !outputs.audio &&
            !(outputs.parts.length && outputs.parts.length === outputs.total)) ||
          (filter === 'video' && !outputs.video)
        )
          return null;
        const labels = outputLabels(source, slide);
        const artifacts = record
          ? source.artifacts.filter((a) => a.slideId === slide.id)
          : [...(outputs.audio ? [outputs.audio] : outputs.parts), outputs.video, outputs.composition].filter(
              (a) => !!a,
            );
        return (
          <article className="batch-page" key={slide.id}>
            <div>
              <strong>
                第 {record?.number ?? i + 1} 页　{slide.title}
              </strong>
              <div className="batch-stages">
                {Object.values(labels).map((label) => (
                  <span key={label}>{label}</span>
                ))}
              </div>
              {record?.error && (
                <p role="status" className="batch-error">
                  {record.error}
                </p>
              )}
            </div>
            <div className="batch-actions">
              {artifacts.length > 0 && (
                <button className="button" onClick={() => setExpanded(expanded === slide.id ? '' : slide.id)}>
                  {expanded === slide.id ? '收起素材' : '查看素材'}
                </button>
              )}
              {!outputs.composition && (
                <button
                  className="button primary"
                  disabled={disabled || sending}
                  onClick={() => prepare(slide, 'resume')}
                >
                  {record?.error || outputs.parts.length || outputs.video || !batch
                    ? '重试 / 继续本页'
                    : '生成本页'}
                </button>
              )}
              {batch && !slide.recordedAudioId && !slide.keepBackgroundAudio && (
                <button
                  className="button"
                  disabled={disabled || sending}
                  onClick={() => prepare(slide, 'audio')}
                >
                  重做配音
                </button>
              )}
              {batch && (
                <button
                  className="button"
                  disabled={disabled || sending}
                  onClick={() => void pickRecording(slide)}
                >
                  替换配音文件
                </button>
              )}
              {batch && outputs.presenter && (
                <button
                  className="button"
                  disabled={disabled || sending || !outputs.audio}
                  onClick={() => prepare(slide, 'video')}
                >
                  重做人物视频
                </button>
              )}
            </div>
            {expanded === slide.id && (
              <div className="batch-media">
                {[...artifacts].reverse().map((a) => (
                  <div key={a.id}>
                    <strong>
                      {a.stage === 'audio'
                        ? a.segmentId
                          ? '分段配音'
                          : '整页配音'
                        : a.stage === 'video'
                          ? '人物视频'
                          : '页面成片'}
                    </strong>
                    <small>
                      {new Date(a.createdAt).toLocaleString()} ·{' '}
                      {[outputs.audio, ...outputs.parts, outputs.video, outputs.composition].some(
                        (x) => x?.id === a.id,
                      )
                        ? '当前'
                        : '旧版本'}
                    </small>
                    {a.stage === 'audio' ? (
                      <audio controls preload="none" src={api.mediaUrl(course.id, a.assetId)} />
                    ) : (
                      <video controls preload="none" src={api.mediaUrl(course.id, a.assetId)} />
                    )}
                    <OpenMediaLocation courseId={course.id} id={a.assetId} />
                  </div>
                ))}
              </div>
            )}
          </article>
        );
      })}
      {order && selected && (
        <div className="batch-confirm" role="group" aria-label="返修预算">
          <strong>
            {order.recordingId ? '采用本地录音' : operationName[order.operation]} · {selected.title}
          </strong>
          <p>
            {batch
              ? `第 ${batches.indexOf(batch) + 1} 批 · 使用本批次保存的讲稿与设置。`
              : '按当前课程设置生成，单独保存为一个新批次。'}
            {order.operation === 'audio' && '新配音完成后，人物视频和成片需要重新生成。'}
          </p>
          <p>预计新增 ¥{((estimateMicros ?? 0) / 1e6).toFixed(2)}</p>
          <label>
            本次费用上限（元）{' '}
            <input
              type="number"
              min="0"
              step="0.01"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
          </label>
          <button
            className="button primary"
            disabled={disabled || sending || !limit || !Number.isFinite(Number(limit)) || Number(limit) < 0}
            onClick={() => void confirm()}
          >
            确认预算并提交
          </button>
          <button className="button" disabled={sending} onClick={() => setOrder(undefined)}>
            取消
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
