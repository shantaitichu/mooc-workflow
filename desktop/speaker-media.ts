import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { actorInput, alphaEncode } from './actor-video';
import { run } from './process';
import type { WorkspaceStore } from './store';
import type { MotionAsset, MotionCut } from '../shared/types';
import { fingerprint } from '../shared/domain';

async function trimActor(
  ffmpeg: string,
  input: string,
  codec: string | undefined,
  start: number,
  end: number,
  output: string,
) {
  await run(
    ffmpeg,
    [
      '-v',
      'error',
      '-ss',
      String(start),
      ...actorInput(input, codec),
      '-t',
      String(end - start),
      '-map',
      '0:v:0',
      ...alphaEncode,
      output,
    ],
    { timeoutMs: 900000 },
  );
}

const writingCuts = new Map<string, Promise<string>>();
export async function savedCutFile(
  store: WorkspaceStore,
  courseId: string,
  cutId: string,
  ffmpeg: () => Promise<string>,
) {
  const course = store.get(courseId);
  const cut = course.speaker.savedCuts?.find((item) => item.id === cutId);
  if (!cut) throw new Error('该选段已删除或不在当前讲师档案中。');
  const source = course.assets.find((asset) => asset.id === cut.sourceId && asset.kind === 'video');
  if (
    !source?.info.transparent ||
    !source.info.durationMs ||
    !Number.isSafeInteger(cut.startMs) ||
    !Number.isSafeInteger(cut.endMs) ||
    cut.startMs < 0 ||
    cut.endMs <= cut.startMs ||
    cut.endMs > source.info.durationMs
  )
    throw new Error('选段的原视频或时间范围无效。');
  const dir = path.join(store.courseRoot(courseId), '动作选段');
  const name = cut.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 48);
  const key = fingerprint({ cutId, source: source.sha256, start: cut.startMs, end: cut.endMs });
  const file = path.join(dir, '选段-' + name + '-' + key.slice(0, 16) + '.webm');
  const existing = statSync(file, { throwIfNoEntry: false });
  if (existing?.isFile() && existing.size) return file;
  const pending = writingCuts.get(file);
  if (pending) return pending;
  const input = store.assetPath(courseId, source.id);
  if (!statSync(input, { throwIfNoEntry: false })?.isFile()) throw new Error('原视频文件已移动或删除。');
  mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, '.' + randomUUID() + '.webm');
  const task = (async () => {
    try {
      await trimActor(
        await ffmpeg(),
        input,
        source.info.videoCodec,
        cut.startMs / 1000,
        cut.endMs / 1000,
        temp,
      );
      renameSync(temp, file);
      return file;
    } finally {
      rmSync(temp, { force: true });
    }
  })();
  writingCuts.set(file, task);
  try {
    return await task;
  } finally {
    writingCuts.delete(file);
  }
}

// Frames sampled at 5 Hz. Group movement separated by a quiet interval and label its dominant region.
export function motionIntervals(frames: Buffer, duration: number) {
  const w = 80,
    h = 60,
    area = w * h,
    clips: { start: number; end: number; name: string }[] = [];
  let start = -1,
    last = -1,
    head = 0,
    arms = 0;
  function finish() {
    if (start >= 0 && last - start >= 2)
      clips.push({
        start: Math.max(0, (start - 1) / 5),
        end: Math.min(duration, (last + 2) / 5),
        name: head > arms ? '头部动作' : '上身／手势动作',
      });
    start = -1;
    head = 0;
    arms = 0;
  }
  for (let f = 1; f < Math.floor(frames.length / area); f++) {
    let upper = 0,
      lower = 0;
    for (let y = 3; y < h - 3; y++)
      for (let x = 3; x < w - 3; x++) {
        const i = f * area + y * w + x;
        if (Math.abs(frames[i] - frames[i - area]) < 15) continue;
        if (y < h * 0.43 && x > w * 0.28 && x < w * 0.72) upper++;
        else lower++;
      }
    if (upper + lower > 18) {
      if (start < 0) start = f;
      last = f;
      head += upper;
      arms += lower;
    } else if (start >= 0 && f - last >= 3) finish();
  }
  finish();
  return clips;
}
export async function splitMotion(store: WorkspaceStore, courseId: string, ffmpeg: string, cut?: MotionCut) {
  const course = store.get(courseId),
    source = course.assets.find((a) => a.id === course.speaker.videoAssetId);
  if (!source?.info.durationMs) throw new Error('请先导入人物视频。');
  if (!source.info.transparent) throw new Error('请先在讲师档案完成人物动作视频抠像。');
  const input = store.assetPath(courseId, source.id);
  const dir = mkdtempSync(path.join(tmpdir(), 'mooc-motion-'));
  try {
    let intervals: { start: number; end: number; name: string }[];
    if (cut) {
      if (source.id !== cut.sourceId || cut.endMs > source.info.durationMs || cut.endMs - cut.startMs < 40)
        throw new Error('原视频已更换或选区不足一帧，请重新选择。');
      intervals = [{ start: cut.startMs / 1000, end: cut.endMs / 1000, name: cut.name.trim() || '手动动作' }];
    } else {
      intervals = (await suggestMotionCuts(store, courseId, ffmpeg)).map((c) => ({
        start: c.startMs / 1000,
        end: c.endMs / 1000,
        name: c.name,
      }));
    }
    if (!intervals.length) throw new Error('未检测到可分离的动作，请使用有明显动作和停顿的固定机位视频。');
    const motions: MotionAsset[] = [];
    for (const [i, clip] of intervals.entries()) {
      const name = clip.name + ' ' + clip.start.toFixed(1) + '–' + clip.end.toFixed(1) + '秒';
      const key = source.sha256 + ':' + clip.start + ':' + clip.end;
      if (
        course.speaker.motions.some(
          (m) => m.sourceClip === key || (!cut && m.sourceClip === source.sha256 + ':' + clip.start),
        )
      )
        continue;
      if (course.speaker.motions.length + motions.length >= 100) throw new Error('动作库已达 100 段上限。');
      const file = path.join(dir, i + '.webm');
      await trimActor(ffmpeg, input, source.info.videoCodec, clip.start, clip.end, file);
      const asset = store.addAsset(
        courseId,
        file,
        'video',
        { transparent: true, durationMs: Math.round(1000 * (clip.end - clip.start)), warnings: [] },
        name + '.webm',
      );
      motions.push({
        id: randomUUID(),
        name,
        assetId: asset.id,
        sourceClip: key,
        preset: 'explain',
        startPose: '',
        endPose: '',
        reviewed: false,
        loopable: false,
        createdAt: new Date().toISOString(),
      });
    }
    return store.mutate(courseId, (c) => {
      c.speaker.motions.push(
        ...motions.filter((m) => !c.speaker.motions.some((existing) => existing.sourceClip === m.sourceClip)),
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function suggestMotionCuts(
  store: WorkspaceStore,
  courseId: string,
  ffmpeg: string,
): Promise<MotionCut[]> {
  const course = store.get(courseId);
  const source = course.assets.find((a) => a.id === course.speaker.videoAssetId);
  if (!source?.info.durationMs || !source.info.transparent)
    throw new Error('请先在讲师档案导入已抠像的人物动作视频。');
  const dir = mkdtempSync(path.join(tmpdir(), 'mooc-detect-'));
  try {
    const raw = path.join(dir, 'movement.gray');
    await run(ffmpeg, [
      '-v',
      'error',
      ...actorInput(store.assetPath(courseId, source.id)),
      '-vf',
      'fps=5,format=gbrap,premultiply=inplace=1,scale=80:60',
      '-pix_fmt',
      'gray',
      '-f',
      'rawvideo',
      raw,
    ]);
    return motionIntervals(readFileSync(raw), source.info.durationMs / 1000).map((c) => ({
      sourceId: source.id,
      name: c.name,
      startMs: Math.round(c.start * 1000),
      endMs: Math.round(c.end * 1000),
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
