import type { Course, MotionCut, Slide } from './types';
import { matteCost } from './domain';

export const frameMs = 40;
export const snapMs = (ms: number) => Math.max(0, Math.round(ms / frameMs) * frameMs);

export function findSavedCut(course: Course, cut: MotionCut) {
  return course.speaker.savedCuts?.find(
    (item) => item.sourceId === cut.sourceId && item.startMs === cut.startMs && item.endMs === cut.endMs,
  );
}

// Each generated driver contains a brief idle lead and return. Short selections use six seconds of driver.
export function motionCutSpec(durationMs: number, frame?: { width?: number; height?: number }) {
  if (!Number.isFinite(durationMs) || durationMs < 120 || durationMs > 28800)
    throw new Error('请选择 0.12–28.8 秒的动作，给模型留出起势和收势时间。');
  const gestureFrames = Math.round(durationMs / frameMs);
  const driverFrames = Math.max(150, gestureFrames + 30);
  const driverMs = driverFrames * frameMs;
  return {
    driverMs,
    gestureFrames,
    leadFrames: Math.floor((driverFrames - gestureFrames) / 2),
    budgetMicros: Math.ceil((driverMs * 500 + matteCost(driverMs + 80, frame)) / 10000) * 10000,
  };
}

export function resolveTrack(course: Course, slide: Slide, durationMs: number) {
  const ordered = [...(slide.motionTrack ?? [])].sort((a, b) => a.startMs - b.startMs);
  return ordered.map((cue, i) => {
    const motion = course.speaker.motions.find((m) => m.id === cue.motionId && m.reviewed);
    if (!motion) throw new Error('动作轨道引用了未验收或已移除的素材，请重新选择。');
    const asset = course.assets.find((a) => a.id === motion.assetId);
    if (!asset?.info.durationMs) throw new Error('动作素材缺少有效时长。');
    const startMs = snapMs(cue.startMs),
      next = ordered[i + 1];
    if (next && snapMs(next.startMs) === startMs) throw new Error('两个动作不能从同一帧开始。');
    if (startMs >= durationMs)
      throw new Error('动作「' + motion.name + '」起点超出本页配音，请移动或删除该标记。');
    const length = Math.min(
      snapMs(asset.info.durationMs),
      durationMs - startMs,
      next ? snapMs(next.startMs) - startMs : Infinity,
    );
    return { cue, motion, asset, startMs, durationMs: length };
  });
}
