import { pageJoin, type PageJoin } from '../shared/page-join';
import { prepareJoin } from './page-join';
import { editTimeline } from '../shared/edit-timeline';
import { actorInput } from './actor-video';
import { driverAperture, fitPresenter } from '../shared/presenter-frame';
import { writeCaptionTrack } from './caption-raster';
import { canvasTitleColor, geometry } from '../shared/layout';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import type { Course, Slide, MediaInfo, ExportOptions } from '../shared/types';
import { compositionFor, currentArtifact, clockText, stripPauses } from '../shared/domain';
import { captionStrip, toSrt, type Cue } from '../shared/subtitles';
import { WorkspaceStore } from './store';
import { findTool, run } from './process';

export async function probe(file: string, executable?: string): Promise<MediaInfo> {
  const tool = await findTool('ffprobe', executable);
  if (!tool) throw new Error('请先在设置中指定 FFprobe。');
  const data = JSON.parse(
    await run(tool, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]),
  );
  const video = data.streams?.find((s: any) => s.codec_type === 'video');
  const rotation = Number(
    video?.side_data_list?.find((v: any) => v.rotation != null)?.rotation ?? video?.tags?.rotate ?? 0,
  );
  const sideways = Math.abs(rotation) % 180 === 90;
  const audio = data.streams?.find((s: any) => s.codec_type === 'audio');
  const duration = Number(data.format?.duration ?? audio?.duration ?? video?.duration ?? 0);
  const ratio = String(video?.avg_frame_rate ?? '0/1')
    .split('/')
    .map(Number);
  const warnings: string[] = [];
  if (audio && Number(audio.sample_rate) < 16000) warnings.push('音频采样率偏低，建议重新录制清晰干声。');
  if (video && video.width < 640) warnings.push('人物画面分辨率偏低，可能影响口型效果。');
  return {
    durationMs: Math.round(duration * 1000),
    videoCodec: video?.codec_name,
    container: data.format?.format_name,
    width: sideways ? video?.height : video?.width,
    height: sideways ? video?.width : video?.height,
    fps: ratio[1] ? ratio[0] / ratio[1] : undefined,
    sampleRate: audio ? Number(audio.sample_rate) : undefined,
    hasAudio: Boolean(audio),
    warnings,
  };
}
export class MediaEngine {
  constructor(readonly store: WorkspaceStore) {}
  async ffmpeg() {
    const tool = await findTool('ffmpeg', this.store.settings().ffmpegPath);
    if (!tool) throw new Error('请先在设置中指定 FFmpeg。');
    return tool;
  }
  async normalizeAudio(source: string, destination: string, signal?: AbortSignal, trailingPauseMs = 0) {
    const raw = `${destination}.normalized.wav`;
    await run(
      await this.ffmpeg(),
      [
        '-y',
        '-v',
        'error',
        '-i',
        source,
        '-vn',
        '-af',
        'aresample=48000,loudnorm=I=-18:TP=-1.5:LRA=7',
        '-ar',
        '48000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        raw,
      ],
      { signal },
    );
    const info = await probe(raw, this.store.settings().ffprobePath);
    const alignedDuration = (Math.ceil(((info.durationMs ?? 0) + trailingPauseMs) / 40) * 40) / 1000;
    await run(
      await this.ffmpeg(),
      [
        '-y',
        '-v',
        'error',
        '-i',
        raw,
        '-af',
        `apad,atrim=duration=${alignedDuration}`,
        '-ar',
        '48000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        destination,
      ],
      { signal },
    );
    return probe(destination, this.store.settings().ffprobePath);
  }
  async concatAudio(files: string[], output: string, pauseMs = 0, signal?: AbortSignal): Promise<MediaInfo> {
    if (!files.length) throw new Error('没有可合成的音频');
    const args = files.flatMap((f) => ['-i', f]);
    const inputs = files.map((_, i) => `[${i}:a]`).join('');
    await run(
      await this.ffmpeg(),
      [
        '-y',
        '-v',
        'error',
        ...args,
        '-filter_complex',
        `${inputs}concat=n=${files.length}:v=0:a=1,apad=pad_dur=${pauseMs / 1000}[a]`,
        '-map',
        '[a]',
        '-ar',
        '48000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        output,
      ],
      { signal },
    );
    return probe(output, this.store.settings().ffprobePath);
  }
  async concatVideo(files: string[], output: string, signal?: AbortSignal) {
    if (!files.length) throw new Error('没有可合成的视频');
    const list = path.join(path.dirname(output), `concat-${Date.now()}.txt`);
    writeFileSync(
      list,
      files
        .map((file) => `file '${path.resolve(file).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
        .join('\n'),
      'utf8',
    );
    await run(
      await this.ffmpeg(),
      [
        '-y',
        '-v',
        'error',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        list,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c',
        'copy',
        '-movflags',
        '+faststart+use_metadata_tags',
        '-metadata',
        'comment=AI-generated digital presenter; Mooc Studio',
        output,
      ],
      { timeoutMs: 3600000, signal },
    );
  }
  async baseFrame(course: Course, slide: Slide, output: string, transparent = false) {
    const options = compositionFor(course, slide);
    const canvas = createCanvas(1920, 1080);
    const c = canvas.getContext('2d');
    if (!transparent) {
      c.fillStyle = options.backgroundColor;
      c.fillRect(0, 0, 1920, 1080);
    }
    const background = course.assets.find((a) => a.id === slide.backgroundAssetId);
    if (background?.kind === 'image') {
      const img = await loadImage(this.store.assetPath(course.id, background.id));
      const scale = Math.min(1920 / img.width, 1080 / img.height);
      c.drawImage(
        img,
        (1920 - img.width * scale) / 2,
        (1080 - img.height * scale) / 2,
        img.width * scale,
        img.height * scale,
      );
    }
    if (slide.assetId && options.layout !== 'presenter') {
      const image = await loadImage(this.store.assetPath(course.id, slide.assetId));
      const box = geometry(options).deck;
      const scale = Math.min(box.w / image.width, box.h / image.height);
      c.drawImage(
        image,
        box.x + (box.w - image.width * scale) / 2,
        box.y + (box.h - image.height * scale) / 2,
        image.width * scale,
        image.height * scale,
      );
    } else if (!slide.backgroundAssetId) {
      c.font = 'bold 64px "Microsoft YaHei", sans-serif';
      c.fillStyle = canvasTitleColor(options.backgroundColor);
      const lines = slide.title.match(/.{1,20}/gu) ?? [];
      lines.forEach((line, i) => c.fillText(line, 100, 360 + i * 90));
    }
    if (options.logoAssetId) {
      const logo = await loadImage(this.store.assetPath(course.id, options.logoAssetId));
      const scale = Math.min(180 / logo.width, 75 / logo.height);
      const width = logo.width * scale,
        height = logo.height * scale;
      c.drawImage(logo, 55 + (180 - width) / 2, 30 + (75 - height) / 2, width, height);
    }
    writeFileSync(output, canvas.toBuffer('image/png'));
  }
  async compose(
    course: Course,
    slide: Slide,
    audioFile: string,
    presenterFile: string | undefined,
    cues: Cue[],
    output: string,
    signal?: AbortSignal,
    burnOverride?: boolean,
    join?: { spec: PageJoin; file: string },
  ): Promise<MediaInfo> {
    const options = compositionFor(course, slide);
    const dir = path.dirname(output);
    mkdirSync(dir, { recursive: true });
    const audioInfo = await probe(audioFile, this.store.settings().ffprobePath);
    const duration = (audioInfo.durationMs ?? 0) / 1000;
    if (duration <= 0) throw new Error('音频时长为零');
    const background = course.assets.find((a) => a.id === slide.backgroundAssetId);
    const total = Math.ceil(duration * 25) / 25;
    const frame = path.join(dir, 'background.png');
    await this.baseFrame(course, slide, frame, background?.kind === 'video');
    const args: string[] = [
      '-y',
      '-v',
      'error',
      '-loop',
      '1',
      '-framerate',
      '25',
      '-i',
      frame,
      '-i',
      audioFile,
    ];
    const filters: string[] = [
      `[0:v]format=${background?.kind === 'video' ? 'rgba' : 'yuv420p'},setsar=1[base]`,
    ];
    let base = 'base';
    let nextInput = 2;
    if (background?.kind === 'video') {
      if (slide.backgroundEndMs && slide.backgroundEndMs <= slide.backgroundStartMs)
        throw new Error('背景结束时间须晚于开始时间');
      const source = this.store.assetPath(course.id, background.id);
      const backgroundCodec =
        background.info.videoCodec ??
        (path.extname(source).toLowerCase() === '.webm'
          ? (await probe(source, this.store.settings().ffprobePath)).videoCodec
          : undefined);
      const sourceInput = actorInput(source, backgroundCodec ?? '');
      const onCanvas = (input: string) =>
        `color=c=${options.backgroundColor.replace('#', '0x')}:s=1920x1080:r=25[canvas];` +
        `[${input}]fps=25,scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[scaledbg];` +
        '[canvas][scaledbg]overlay=(W-w)/2:(H-h)/2:shortest=1[paintedbg]';
      let backgroundStream = `${nextInput++}:v`;
      const loop = slide.shortBackground === 'loop';
      if (loop && (slide.backgroundStartMs || slide.backgroundEndMs)) {
        const clipped = path.join(dir, 'background-clip.mkv');
        const trim = ['-y', '-v', 'error', '-ss', String(slide.backgroundStartMs / 1000), ...sourceInput];
        if (slide.backgroundEndMs)
          trim.push('-t', String((slide.backgroundEndMs - slide.backgroundStartMs) / 1000));
        await run(
          await this.ffmpeg(),
          [
            ...trim,
            '-an',
            '-filter_complex',
            onCanvas('0:v'),
            '-map',
            '[paintedbg]',
            '-c:v',
            'ffv1',
            '-pix_fmt',
            'yuv420p',
            clipped,
          ],
          { signal, timeoutMs: 900000 },
        );
        args.push('-stream_loop', '-1', '-i', clipped);
      } else {
        if (loop) args.push('-stream_loop', '-1');
        else {
          args.push('-ss', String(slide.backgroundStartMs / 1000));
          if (slide.backgroundEndMs)
            args.push('-t', String((slide.backgroundEndMs - slide.backgroundStartMs) / 1000));
        }
        args.push(...sourceInput);
        filters.push(onCanvas(backgroundStream));
        backgroundStream = 'paintedbg';
      }
      filters.push(`[${backgroundStream}]tpad=stop_mode=clone:stop_duration=${total}[bgvideo]`);
      filters.push('[bgvideo][base]overlay=0:0[withdeck]');
      base = 'withdeck';
    }
    if (options.layout !== 'slides' && !slide.keepBackgroundAudio) {
      if (!presenterFile) throw new Error('此版式需要人物视频。请先生成人物，或选择纯 PPT 配音版式。');
      const presenter = await probe(presenterFile, this.store.settings().ffprobePath);
      if (!presenter.width || !presenter.height) throw new Error('无法读取人物视频尺寸。');
      args.push(...actorInput(presenterFile, presenter.videoCodec));
      const idle =
        slide.videoModel !== 'omnihuman-1.5'
          ? course.assets.find((a) => a.id === course.speaker.idleAssetId && a.info.transparent)
          : undefined;
      const reference =
        idle && (!idle.info.width || !idle.info.height)
          ? await probe(this.store.assetPath(course.id, idle.id), this.store.settings().ffprobePath)
          : idle?.info;
      const crop = driverAperture(reference, presenter);
      const cropFilter = crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : '';
      const { w, h, x, y } = fitPresenter(
        geometry(options).person,
        crop ?? { w: presenter.width, h: presenter.height },
      );
      let actorStream = `${nextInput++}:v`;
      if (join) {
        args.push(...actorInput(join.file, 'vp9'));
        const speechFrames = Math.round(join.spec.startMs / 40);
        filters.push(
          `[${actorStream}]fps=25,format=yuva420p,setsar=1,trim=end_frame=${speechFrames},setpts=PTS-STARTPTS[spoken]`,
        );
        filters.push(`[${nextInput++}:v]fps=25,format=yuva420p,setsar=1,setpts=PTS-STARTPTS[bridge]`);
        filters.push('[spoken][bridge]concat=n=2:v=1:a=0[joined]');
        actorStream = 'joined';
      }
      filters.push(
        `[${actorStream}]${cropFilter}scale=${w}:${h},format=yuva420p,setsar=1,fps=25,tpad=stop_mode=clone:stop_duration=${total}[person]`,
      );
      filters.push(`[${base}][person]overlay=${x}:${y}:eof_action=repeat[withperson]`);
      base = 'withperson';
    }
    const srt = path.join(dir, 'captions.srt');
    writeFileSync(srt, toSrt(cues), 'utf8');
    if ((burnOverride ?? options.burnSubtitles) && cues.length) {
      const track = writeCaptionTrack(dir, cues, options.subtitleSize);
      args.push('-f', 'concat', '-i', track);
      const { y } = captionStrip(options.subtitleSize, geometry(options).margin);
      filters.push(`[${base}][${nextInput++}:v]overlay=0:${y}:eof_action=repeat[subbed]`);
      base = 'subbed';
    }
    filters.push(`[1:a]apad,atrim=duration=${total},aresample=48000[a]`);
    args.push(
      '-filter_complex_threads',
      '1',
      '-filter_complex',
      filters.join(';'),
      '-map',
      `[${base}]`,
      '-map',
      '[a]',
      '-t',
      String(total),
      '-r',
      '25',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '16',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-movflags',
      '+faststart+use_metadata_tags',
      '-metadata',
      `comment=${JSON.stringify({ generated: true, provider: 'Mooc Studio', courseId: course.id, slideId: slide.id, sourceArtifacts: course.artifacts.filter((a) => a.slideId === slide.id).map((a) => a.id) })}`,
      output,
    );
    await run(await this.ffmpeg(), args, { cwd: dir, signal, timeoutMs: 3600000 });
    return probe(output, this.store.settings().ffprobePath);
  }
  pageSources(course: Course, slide: Slide) {
    const artifact = currentArtifact(course, slide, 'composition')!;
    const dir = path.join(this.store.courseRoot(course.id), 'renders', artifact.fingerprint);
    const audio = path.join(dir, 'page.wav'),
      cachedPresenter = path.join(dir, 'presenter.webm');
    const cueFile = path.join(dir, 'cues.json');
    const video = currentArtifact(course, slide, 'video');
    return {
      audio: existsSync(audio) ? audio : this.store.assetPath(course.id, artifact.assetId),
      presenter: video
        ? this.store.assetPath(course.id, video.assetId)
        : existsSync(cachedPresenter)
          ? cachedPresenter
          : undefined,
      cues: existsSync(cueFile)
        ? (JSON.parse(readFileSync(cueFile, 'utf8')) as Cue[])
        : editTimeline({ ...course, slides: [slide] })[0].captions,
    };
  }
  async export(course: Course, destination: string, options: ExportOptions, signal?: AbortSignal) {
    if (!course.slides.length) throw new Error('没有可导出的页面');
    const missing = course.slides.filter((s) => !currentArtifact(course, s, 'composition'));
    if (missing.length) throw new Error(`${missing.length} 页尚未生成或需要更新，请先完成。`);
    mkdirSync(destination, { recursive: true });
    const videos: string[] = [];
    const allCues: Cue[] = [];
    const chapters: string[] = [];
    const joins = course.slides.map((s, i) => pageJoin(course, s, course.slides[i + 1]));
    const scratch = mkdtempSync(path.join(destination, '.render-'));
    try {
      let cursor = 0;
      for (const [index, slide] of course.slides.entries()) {
        const artifact = currentArtifact(course, slide, 'composition')!;
        let file = this.store.assetPath(course.id, artifact.assetId);
        const { audio, presenter, cues } = this.pageSources(course, slide);
        const outgoing = joins[index];
        const settings = compositionFor(course, slide);
        if (outgoing || options.subtitles !== settings.burnSubtitles || artifact.model === 'ffmpeg-1080p25') {
          const join = outgoing && {
            spec: outgoing,
            file: await prepareJoin(this.store, course.id, outgoing, await this.ffmpeg()),
          };
          // Export and generation may run concurrently. Keep caption rasters and FFmpeg inputs separate.
          const tempDir = mkdtempSync(path.join(scratch, 'page-'));
          const rendered = path.join(tempDir, 'page.mp4');
          await this.compose(
            course,
            slide,
            audio,
            presenter,
            cues,
            rendered,
            signal,
            options.subtitles,
            join,
          );
          file = rendered;
        }
        videos.push(file);
        allCues.push(...cues.map((c) => ({ ...c, startMs: c.startMs + cursor, endMs: c.endMs + cursor })));
        chapters.push(`${clockText(cursor)}\t${index + 1}\t${slide.title}`);
        cursor += artifact.durationMs;
        if (options.perSlide) {
          const target = path.join(destination, 'pages');
          mkdirSync(target, { recursive: true });
          copyFileSync(file, path.join(target, `${String(index + 1).padStart(3, '0')}.mp4`));
        }
      }
      const output = path.join(destination, 'course.mp4');
      await this.concatVideo(videos, output, signal);
      writeFileSync(path.join(destination, 'subtitles.srt'), toSrt(allCues), 'utf8');
      writeFileSync(path.join(destination, 'chapters.tsv'), chapters.join('\n'), 'utf8');
      writeFileSync(
        path.join(destination, 'provenance.json'),
        JSON.stringify(
          {
            courseId: course.id,
            revision: course.revision,
            exportedAt: new Date().toISOString(),
            generated: true,
            subtitleTiming: 'segment-bounded; intra-segment text-proportional; requires review',
            artifacts: course.artifacts,
          },
          null,
          2,
        ),
      );
      if (options.audio)
        await run(
          await this.ffmpeg(),
          [
            '-y',
            '-v',
            'error',
            '-i',
            output,
            '-vn',
            '-ar',
            '48000',
            '-ac',
            '1',
            '-c:a',
            'pcm_s16le',
            path.join(destination, 'narration.wav'),
          ],
          { signal, timeoutMs: 3600000 },
        );
      if (options.project) this.store.exportArchive(course.id, path.join(destination, 'project.mooc'));
      return output;
    } finally {
      await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}
