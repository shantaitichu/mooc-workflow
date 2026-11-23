import { motionCutSpec } from '../shared/motion-track';
import path from 'node:path';
import { run } from './process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

export const alphaEncode = [
  '-an',
  '-c:v',
  'libvpx-vp9',
  '-pix_fmt',
  'yuva420p',
  '-b:v',
  '0',
  '-lossless',
  '1',
  '-deadline',
  'realtime',
  '-cpu-used',
  '6',
  '-row-mt',
  '1',
  '-threads',
  '4',
];
// All WebM assets produced by the workbench use VP9. Its native FFmpeg decoder discards the auxiliary alpha stream.
export function actorInput(file: string, codec?: string) {
  const videoCodec = codec ?? (path.extname(file).toLowerCase() === '.webm' ? 'vp9' : '');
  const decoder = videoCodec === 'vp8' ? 'libvpx' : videoCodec === 'vp9' ? 'libvpx-vp9' : undefined;
  return [...(decoder ? ['-c:v', decoder] : []), '-i', file];
}
type Frame = { width: number; height: number };
type Crop = { x: number; y: number; w: number; h: number };
export function sourceFrame(info: { width?: number; height?: number }): Frame {
  if (!info.width || !info.height) throw new Error('无法读取人物素材原始尺寸。');
  return { width: 2 * Math.ceil(info.width / 2), height: 2 * Math.ceil(info.height / 2) };
}
const evenPad = 'pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:color=black@0';
const nativeTrack = 'fps=25,format=yuva420p,' + evenPad + ',setsar=1';
function fitAction(frame: Frame, crop?: Crop) {
  const size = frame.width + ':' + frame.height;
  const aperture = crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : '';
  return (
    aperture +
    nativeTrack +
    ',scale=' +
    size +
    ':flags=lanczos:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=' +
    size +
    ':(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1'
  );
}
const uploadEncode = ['-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '12', '-preset', 'veryfast'];
// Check actual alpha values, not just container metadata. Missing alpha must never turn into a black rectangle.
export async function hasMatte(ffmpeg: string, file: string, duration: number, codec?: string) {
  if (!duration) return false;
  // A fade or a presenter entering late can leave an individual frame uniformly transparent.
  const times = [0.5, 0.25, 0.75, 0, 0.9].map((f) => Math.floor(Math.max(0, duration - 40) * f) / 1000);
  for (const at of new Set(times)) {
    try {
      const stats = await run(ffmpeg, [
        '-v',
        'error',
        '-ss',
        String(at),
        ...actorInput(file, codec),
        '-vf',
        // Convert the alpha plane to full-range 8-bit before applying any thresholds (including ProRes 4444).
        'trim=end_frame=1,alphaextract,scale=128:128:flags=area:in_range=full:out_range=full,format=gray,format=yuv444p,signalstats,metadata=print:file=-',
        '-frames:v',
        '1',
        '-f',
        'null',
        '-',
      ]);
      if (
        [...stats.matchAll(/YMIN=([.\d]+)/g)].some((x) => +x[1] < 50) &&
        [...stats.matchAll(/YMAX=([.\d]+)/g)].some((x) => +x[1] > 190)
      )
        return true;
    } catch {
      return false;
    }
  }
  return false;
}
export async function normalizeActor(ffmpeg: string, file: string, out: string, codec?: string) {
  await run(
    ffmpeg,
    ['-y', '-v', 'error', ...actorInput(file, codec), '-vf', 'format=yuva420p', ...alphaEncode, out],
    { timeoutMs: 900000 },
  );
}
export async function matteInput(
  ffmpeg: string,
  file: string,
  out: string,
  codec?: string,
  loopMs?: number,
  signal?: AbortSignal,
) {
  await run(
    ffmpeg,
    [
      '-y',
      '-v',
      'error',
      ...(loopMs ? ['-stream_loop', '-1'] : []),
      ...actorInput(file, codec),
      '-vf',
      (loopMs ? 'fps=25,' : '') + 'format=gbrap,premultiply=inplace=1,' + evenPad,
      ...(loopMs ? ['-frames:v', String(Math.max(1, Math.round(loopMs / 40)))] : []),
      ...uploadEncode,
      out,
    ],
    { timeoutMs: 900000, signal },
  );
}
export async function actorTrack(
  ffmpeg: string,
  idle: string,
  idleMs: number,
  frame: Frame,
  clips: {
    file: string;
    startMs: number;
    durationMs: number;
    sourceMs?: number;
    inMs?: number;
    /** Only used when preparing a reusable asset with matched idle endpoints. */
    matchIdleEnds?: boolean;
    crop?: Crop;
  }[],
  totalMs: number,
  out: string,
  signal?: AbortSignal,
) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mooc-actor-')),
    parts: string[] = [];
  const total = Math.max(1, Math.round(totalMs / 40));
  async function part(start: number, count: number, clip?: (typeof clips)[number]) {
    if (count <= 0) return;
    const args = ['-y', '-v', 'error'];
    if (!clip || clip.matchIdleEnds)
      args.push('-stream_loop', '-1', '-ss', String(((start * 40) % idleMs) / 1000), ...actorInput(idle));
    let filter = '[0:v]' + nativeTrack + '[out]';
    if (clip) {
      args.push('-ss', String((clip.inMs ?? 0) / 1000), ...actorInput(clip.file));
      const speed = clip.sourceMs ? Math.min(1, (count * 40) / clip.sourceMs) : 1;
      const action = `setpts=${speed}*(PTS-STARTPTS),${fitAction(frame, clip.crop)},tpad=stop_mode=clone:stop_duration=1`;
      filter = `[0:v]${action}[out]`;
      if (clip.matchIdleEnds) {
        const frames = Math.max(1, Math.min(6, Math.floor((count - 1) / 2)));
        const weight = `max(0,min(1,min((N-1)/${frames},(${count}-N)/${frames})))`;
        filter = `[0:v]${nativeTrack}[idle];[1:v]${action}[gesture];[idle][gesture]blend=all_expr='A*(1-(${weight}))+B*(${weight})'[out]`;
      }
    }
    const file = path.join(dir, parts.length + '.webm');
    await run(
      ffmpeg,
      [...args, '-filter_complex', filter, '-map', '[out]', '-frames:v', String(count), ...alphaEncode, file],
      { signal, timeoutMs: 900000 },
    );
    parts.push(file);
  }
  try {
    let cursor = 0;
    for (const c of clips) {
      const from = Math.round(c.startMs / 40),
        end = Math.min(total, Math.round((c.startMs + c.durationMs) / 40));
      await part(cursor, from - cursor);
      await part(from, end - from, c);
      cursor = end;
    }
    await part(cursor, total - cursor);
    const list = path.join(dir, 'list.txt');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(list, parts.map((_, i) => "file '" + i + ".webm'").join('\n'));
    await run(
      ffmpeg,
      [
        '-y',
        '-v',
        'error',
        '-f',
        'concat',
        '-safe',
        '1',
        '-i',
        'list.txt',
        '-map',
        '0:v',
        '-c',
        'copy',
        path.resolve(out),
      ],
      { signal, cwd: dir },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// Rotate the loop around a short overlap. Its last frame advances naturally into its first.
export async function idleLoop(ffmpeg: string, input: string, duration: number, out: string) {
  const count = Math.round(duration / 40),
    overlap = Math.min(6, Math.floor(count / 4));
  if (count < 10) throw new Error('待机视频至少需要 0.4 秒。');
  const stats = await run(ffmpeg, [
    '-v',
    'error',
    ...actorInput(input),
    '-vf',
    'fps=8,format=gbrap,premultiply=inplace=1,scale=96:-2,format=yuv444p,signalstats,metadata=print:key=lavfi.signalstats.YDIF:file=-',
    '-an',
    '-f',
    'null',
    '-',
  ]);
  if (![...stats.matchAll(/YDIF=([.\d]+)/g)].some((x) => +x[1] > 0.03))
    throw new Error('待机视频未检测到可见变化，请录制有自然呼吸或眨眼的片段。');
  const filter =
    '[0:v]fps=25,format=yuva420p,split=3[x][y][z];[x]trim=start_frame=' +
    overlap +
    ':end_frame=' +
    (count - overlap) +
    ',setpts=PTS-STARTPTS[body];[y]trim=start_frame=' +
    (count - overlap) +
    ',setpts=PTS-STARTPTS[tail];[z]trim=end_frame=' +
    overlap +
    ",setpts=PTS-STARTPTS[head];[tail][head]blend=all_expr='A*(1-min(1,N/" +
    overlap +
    '))+B*min(1,N/' +
    overlap +
    ")'[join];[body][join]concat=n=2:v=1:a=0[out]";
  await run(
    ffmpeg,
    [
      '-y',
      '-v',
      'error',
      ...actorInput(input),
      '-filter_complex',
      filter,
      '-map',
      '[out]',
      ...alphaEncode,
      out,
    ],
    { timeoutMs: 900000 },
  );
}
// A motion reference: approach from idle, perform the selected action, settle back at the same idle phase.
export async function guidedTemplate(
  ffmpeg: string,
  idle: string,
  clip: string,
  clipMs: number,
  out: string,
  idleMs: number,
  frame: Frame,
  startMs = 0,
) {
  const { driverMs, gestureFrames, leadFrames } = motionCutSpec(clipMs);
  const returnFrames = driverMs / 40 - leadFrames - gestureFrames;
  const idleFrames = Math.max(1, Math.round(idleMs / 40));
  const blendFrames = Math.max(1, Math.min(6, Math.floor(gestureFrames / 4)));
  const blendSeconds = blendFrames / 25;
  const tailFrames = returnFrames + blendFrames;
  const returnStart = Math.ceil(tailFrames / idleFrames) * idleFrames - tailFrames;
  const guideFormat = ',format=gbrap,premultiply=inplace=1,format=yuv444p';
  // The model receives a continuous movement guide, with a short transition on both sides of the gesture.
  const graph = [
    '[0:v]' + nativeTrack + guideFormat + ',split=2[open][tail]',
    '[open]trim=end_frame=' + (leadFrames + blendFrames) + ',setpts=PTS-STARTPTS[lead]',
    '[1:v]' +
      fitAction(frame) +
      guideFormat +
      ',tpad=stop_mode=clone:stop_duration=0.12,trim=end_frame=' +
      gestureFrames +
      ',setpts=PTS-STARTPTS[gesture]',
    '[tail]trim=start_frame=' +
      returnStart +
      ':end_frame=' +
      (returnStart + tailFrames) +
      ',setpts=PTS-STARTPTS[return]',
    '[lead][gesture]xfade=duration=' + blendSeconds + ':offset=' + leadFrames / 25 + '[enter]',
    '[enter][return]xfade=duration=' +
      blendSeconds +
      ':offset=' +
      (leadFrames + gestureFrames - blendFrames) / 25 +
      ',format=yuv420p[out]',
  ].join(';');
  await run(
    ffmpeg,
    [
      '-y',
      '-v',
      'error',
      '-stream_loop',
      '-1',
      ...actorInput(idle),
      '-ss',
      String(startMs / 1000),
      ...actorInput(clip),
      '-filter_complex',
      graph,
      '-map',
      '[out]',
      ...uploadEncode,
      '-t',
      String(driverMs / 1000),
      out,
    ],
    { timeoutMs: 300000 },
  );
}
