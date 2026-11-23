import { prepareJoin } from './page-join';
import { savedCutFile } from './speaker-media';
import { narrationDurations } from '../shared/edit-timeline';
import { cleanPageModel, pageJoin } from '../shared/page-join';
import {
  actorInput,
  actorTrack,
  idleLoop,
  guidedTemplate,
  hasMatte,
  matteInput,
  normalizeActor,
  sourceFrame,
} from './actor-video';
import { batchCourse, makeBatch, repairSlide } from '../shared/production-batches';
import { driverAperture } from '../shared/presenter-frame';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { maxPresenterVideoMs, matteModel, matteCost, readyMotion } from '../shared/domain';
import { findSavedCut, resolveTrack, motionCutSpec, snapMs } from '../shared/motion-track';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Course,
  Slide,
  ProductionRequest,
  ProductionMode,
  LocalTask,
  Segment,
  Stage,
  Artifact,
  Asset,
  MotionPreset,
  MotionCut,
  CloudJob,
} from '../shared/types';
import {
  fingerprint,
  voicePreviewFile,
  currentArtifact,
  segmentFingerprint,
  slideFingerprint,
  compositionFor,
  speechFor,
  segmentsFor,
  toSSML,
  validateCourse,
  motionPresets,
  portraitPriceMicros,
  portraitModel,
} from '../shared/domain';
import { pageCaptionCues, type CaptionPart } from '../shared/subtitles';
import { WorkspaceStore } from './store';
import { MediaEngine, probe } from './media';
import { CloudClient } from './cloud';
import { run } from './process';

export class Production {
  private batchIds = new WeakMap<Course, string>();
  private cutting = new Map<string, { selectionKey: string; result: Promise<Course> }>();
  private active = new Map<string, AbortController>();
  constructor(
    readonly store: WorkspaceStore,
    readonly media: MediaEngine,
    readonly cloud: CloudClient,
    readonly change: () => void,
  ) {}
  stop(id: string) {
    this.active.get(id)?.abort();
  }
  shutdown() {
    for (const controller of this.active.values()) controller.abort('shutdown');
  }
  async start(request: ProductionRequest): Promise<string> {
    await this.media.ffmpeg();
    if (this.store.tasks().some(t => t.courseId === request.courseId && t.status === 'running'))
      throw new Error('当前课程已有制作任务，请等待或停止后再试。');
    const live = this.store.get(request.courseId);
    const batch = live.batches?.find(b => b.id === request.batchId);
    if (request.batchId && !batch) throw new Error('生成批次不存在');
    if (request.operation && (!batch || request.slideIds.length !== 1)) throw new Error('返修需要指定本批次的一页。');
    if (request.recordingId && (!batch || request.operation !== 'audio' ||
      !live.assets.some(a => a.id === request.recordingId && a.kind === 'audio')))
      throw new Error('请选择本课程中的音频文件。');
    const snapshot = batch ? batchCourse(live, batch) : live;
    if (batch) {
      const page = batch.pages.find(p => p.slide.id === request.slideIds[0]);
      if (!page || request.slideIds.length !== 1) throw new Error('该页不属于此批次');
      snapshot.slides = [repairSlide(page, request.operation ?? 'resume', Date.now(), request.recordingId)];
    }
    const selected = snapshot.slides.filter((s) => request.slideIds.includes(s.id));
    const mode = request.operation === 'audio' ? 'audio' : request.operation === 'video' ? 'video'
      : request.mode ?? batch?.mode ?? 'full';
    for (const s of selected) {
      if (mode === 'video' && !currentArtifact(snapshot, s, 'audio'))
        throw new Error('「' + s.title + '」缺少与当前讲稿匹配的整页配音，请先生成配音。');
      if (
        mode !== 'audio' && compositionFor(snapshot, s).layout !== 'slides' &&
        !s.keepBackgroundAudio &&
        (s.videoModel ?? 'mediakit-lipsync') === 'mediakit-lipsync'
      ) {
        this.idle(snapshot);
        for (const id of [s.motionId, ...(s.motionTrack ?? []).map((t) => t.motionId)].filter(Boolean)) {
          const m = snapshot.speaker.motions.find((m) => m.id === id);
          if (!m || !readyMotion(snapshot, m) || !m.reviewed)
            throw new Error('本页引用的动作需要按当前待机生成衔接并验收。');
        }
      }
    }
    if (!selected.length) throw new Error('请选择页面');
    const issues = validateCourse({ ...snapshot, slides: selected }, mode === 'audio');
    if (issues.length) throw new Error(issues.join('\n'));
    const task: LocalTask = {
      id: randomUUID(),
      courseId: snapshot.id,
      label: mode === 'audio' ? '生成配音' : mode === 'video' ? '按配音生成视频' : batch ? '批次逐页返修' : request.sample ? '制作样片' : '批量制作',
      status: 'running',
      progress: 0,
      message: '准备素材',
      createdAt: new Date().toISOString(),
    };
    const batchId = batch?.id ?? task.id;
    this.batchIds.set(snapshot, batchId);
    this.store.mutate(live.id, c => {
      if (!batch) (c.batches ??= []).push({ ...makeBatch(live, selected, batchId, task.createdAt, task.label), mode });
      else {
        const record = c.batches!.find(b => b.id === batchId)!.pages.find(p => p.slide.id === selected[0].id)!;
        record.pending = selected[0];
        delete record.error;
      }
    });
    const controller = new AbortController();
    this.active.set(task.id, controller);
    this.store.setTask(task);
    this.change();
    void this.execute(snapshot, selected, task, request.budgetMicros, controller.signal, mode).finally(() =>
      this.active.delete(task.id),
    );
    return task.id;
  }
  private async execute(
    course: Course,
    slides: Slide[],
    task: LocalTask,
    budget: number,
    signal: AbortSignal,
    mode: ProductionMode,
  ) {
    const remaining = { micros: budget };
    const failures: string[] = [];
    const progress = (message: string) => {
      task.message = message;
      this.store.setTask(task);
      this.change();
    };
    for (const [index, slide] of slides.entries()) {
      if (signal.aborted) break;
      task.slideId = slide.id;
      progress(`第 ${index + 1}/${slides.length} 页 · ${slide.title}`);
      try {
        await this.page(course, slide, remaining, signal, (message) =>
          progress(`${slide.title} · ${message}`), mode,
        );
        this.store.mutate(course.id, c => {
          const batch = c.batches!.find(b => b.id === this.batchIds.get(course))!;
          const page = batch.pages.find(p => p.slide.id === slide.id)!;
          if (page.pending) {
            const live = c.slides.find(s => s.id === slide.id);
            const latest = c.batches!.filter(b => b.pages.some(p => p.slide.id === slide.id)).at(-1);
            if (live && latest?.id === batch.id && slideFingerprint(c, live) === slideFingerprint(course, page.slide)) {
              live.videoTake = slide.videoTake;
              live.recordedAudioId = slide.recordedAudioId;
              live.keepBackgroundAudio = slide.keepBackgroundAudio;
              for (const segment of live.segments) segment.take = slide.segments.find(s => s.id === segment.id)?.take;
            }
            page.slide = slide;
            delete page.pending;
          }
          delete page.error;
        });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        this.store.mutate(course.id, c => {
          const batch = c.batches!.find(b => b.id === this.batchIds.get(course))!;
          batch.pages.find(p => p.slide.id === slide.id)!.error = reason;
        });
        failures.push(`${slide.title}：${reason}`);
      }
      task.progress = Math.round(((index + 1) / slides.length) * 100);
      this.store.setTask(task);
      this.change();
    }
    if (mode !== 'audio' && !signal.aborted) {
      const touched = new Set(slides.map(s => s.id));
      for (const [i,left] of course.slides.entries()) {
        const right = course.slides[i+1];
        if (signal.aborted || !right || !(touched.has(left.id) || touched.has(right.id))) continue;
        const spec = pageJoin(course,left,right);
        if (!spec) continue;
        try {
          progress(`本地处理第 ${i+1} → ${i+2} 页讲师衔接`);
          await prepareJoin(this.store,course.id,spec,await this.media.ffmpeg());
        } catch (e) {
          failures.push(`第 ${i+1} 页换页衔接：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    task.status = signal.aborted ? 'cancelled' : failures.length ? 'failed' : 'completed';
    task.message = signal.aborted
      ? '已停止，已完成素材可复用。'
      : failures.length
        ? failures.join('\n')
        : mode === 'audio' ? '配音已就绪，可在动作轨编排后生成视频。' : '已生成，请逐页检查配音、口型、字幕及版式。';
    this.store.setTask(task);
    this.change();
  }
  private addArtifact(
    snapshot: Course,
    slide: Slide,
    stage: Stage,
    file: string,
    durationMs: number,
    model: string,
    segment?: Segment,
    jobId?: string,
  ) {
    const asset = this.store.addAsset(snapshot.id, file, stage === 'audio' ? 'audio' : 'video', {
      durationMs,
      warnings: [],
    });
    const artifact: Artifact = {
      batchId: this.batchIds.get(snapshot),
      id: randomUUID(),
      slideId: slide.id,
      segmentId: segment?.id,
      stage,
      assetId: asset.id,
      durationMs,
      fingerprint:
        segment && stage !== 'composition'
          ? segmentFingerprint(snapshot, slide, segment, stage)
          : slideFingerprint(snapshot, slide, stage),
      createdAt: new Date().toISOString(),
      model,
      sourceJobId: jobId,
    };
    this.store.mutate(snapshot.id, c => {
      c.artifacts.push(artifact);
      const batch = c.batches?.find(b => b.id === this.batchIds.get(snapshot));
      batch?.pages.find(p => p.slide.id === slide.id)?.artifactIds.push(artifact.id);
    });
    snapshot.assets.push(asset);
    snapshot.artifacts.push(artifact);
    this.change();
    return artifact;
  }
  private async page(
    course: Course,
    slide: Slide,
    remaining: { micros: number },
    signal: AbortSignal,
    progress: (message: string) => void,
    mode: ProductionMode = 'full',
  ) {
    const fp = slideFingerprint(course, slide);
    const dir = path.join(this.store.courseRoot(course.id), 'renders', fp);
    mkdirSync(dir, { recursive: true });
    const existingPage = currentArtifact(course, slide, 'composition');
    const narration = currentArtifact(course, slide, 'audio');
    if (mode === 'audio' && narration) { progress('复用已有整页配音'); return; }
    if (mode !== 'audio' && existingPage) {
      if (existingPage.model === 'ffmpeg-1080p25') {
        progress('使用原配音与人物素材更新本地合成');
        const {audio, presenter, cues} = this.media.pageSources(course,slide);
        const output = path.join(dir,'page.mp4');
        const info = await this.media.compose(course,slide,audio,presenter,cues,output,signal);
        this.addArtifact(course,slide,'composition',output,info.durationMs!,cleanPageModel);
      } else progress('复用已有成片');
      return;
    }
    const segments = segmentsFor(slide);
    const audioFiles: string[] = [];
    const captionParts: CaptionPart[] = [];
    let cursor = 0;
    for (const segment of narration ? [] : segments) {
      if (mode === 'video') throw new Error('现有配音已失效，请先生成配音。');
      if (signal.aborted) throw new Error('已停止');
      let audio = currentArtifact(course, slide, 'audio', segment);
      if (!audio) {
        const output = path.join(dir, `${segment.id}.wav`);
        if (slide.recordedAudioId) {
          const info = await this.media.normalizeAudio(
            this.store.assetPath(course.id, slide.recordedAudioId),
            output,
            signal,
          );
          audio = this.addArtifact(
            course,
            slide,
            'audio',
            output,
            info.durationMs!,
            'user-recording',
            segment,
          );
        } else if (slide.keepBackgroundAudio && slide.backgroundAssetId) {
          const args = [
            '-y',
            '-v',
            'error',
            '-ss',
            String(slide.backgroundStartMs / 1000),
            '-i',
            this.store.assetPath(course.id, slide.backgroundAssetId),
          ];
          if (slide.backgroundEndMs)
            args.push('-t', String((slide.backgroundEndMs - slide.backgroundStartMs) / 1000));
          args.push('-vn', '-ar', '48000', '-ac', '1', output);
          await run(await this.media.ffmpeg(), args, { signal });
          const info = await probe(output, this.store.settings().ffprobePath);
          audio = this.addArtifact(
            course,
            slide,
            'audio',
            output,
            info.durationMs!,
            'background-original',
            segment,
          );
        } else {
          const settings = speechFor(course, slide);
          const voiceId = course.speaker.voiceIds[settings.model];
          if (!voiceId) throw new Error('请先在讲师档案中为当前模型复刻音色，或导入真人录音。');
          const lineBreaks = segment.text.match(/\n+$/)?.[0].length ?? 0;
          const spoken = lineBreaks ? segment.text.trimEnd() : segment.text;
          const job = await this.cloud.generate(
            {
              kind: 'speech',
              model: settings.model,
              text: segment.text,
              ssml: toSSML(spoken, lineBreaks ? { ...settings, sentencePauseMs: 0 } : settings),
              speed: settings.speed,
              voiceId,
              fingerprint: segmentFingerprint(course, slide, segment, 'audio'),
            },
            remaining,
            signal,
            progress,
          );
          const raw = path.join(dir, `${segment.id}-raw.wav`);
          await this.cloud.download(job.outputAssetId!, raw);
          const info = await this.media.normalizeAudio(
            raw,
            output,
            signal,
            lineBreaks * settings.paragraphPauseMs,
          );
          audio = this.addArtifact(
            course,
            slide,
            'audio',
            output,
            info.durationMs!,
            settings.model,
            segment,
            job.id,
          );
        }
      }
      audioFiles.push(this.store.assetPath(course.id, audio.assetId));
      captionParts.push({ text: segment.caption, durationMs: audio.durationMs });
      cursor += audio.durationMs;
    }
    const voiceTrack = narration ? this.store.assetPath(course.id, narration.assetId) : path.join(dir, 'narration.wav');
    if (narration) {
      cursor = narration.durationMs;
      const durations = narrationDurations(course, slide, cursor);
      segments.forEach((s,i) => captionParts.push({text: s.caption, durationMs: durations[i]}));
    } else {
      await this.media.concatAudio(audioFiles, voiceTrack, 0, signal);
      this.addArtifact(course, slide, 'audio', voiceTrack, cursor, '整页口播');
    }
    if (mode === 'audio') return;
    const audio = path.join(dir, 'page.wav');
    await this.media.concatAudio([voiceTrack], audio, slide.pagePauseMs, signal);
    let presenter: string | undefined;
    if (compositionFor(course, slide).layout !== 'slides' && !slide.keepBackgroundAudio) {
      let video = currentArtifact(course, slide, 'video');
      if (!video) {
        const model = slide.videoModel ?? 'mediakit-lipsync';
        if (cursor > (model === 'mediakit-lipsync' ? maxPresenterVideoMs : 30000))
          throw new Error('本页配音超过所选人物模型的单次时长上限，请拆成两页或缩短讲稿。');
        const motion = course.speaker.motions.find((m) => m.id === slide.motionId);
        let videoAssetId: string | undefined;
        let driverFrame: ReturnType<typeof sourceFrame> | undefined;
        if (model === 'mediakit-lipsync') {
          const idle = this.idle(course);
          driverFrame = await this.frame(course.id, idle);
          if (motion && (!readyMotion(course, motion) || !motion.reviewed))
            throw new Error('请重新生成并验收衔接动作。');
          const track = resolveTrack(course, slide, cursor);
          if (track.some((t) => !readyMotion(course, t.motion)))
            throw new Error('本页有未经待机衔接处理的旧动作。');
          const clips = await Promise.all(
            track.map(async (t) => ({
              file: this.store.assetPath(course.id, t.asset.id),
              startMs: t.startMs,
              durationMs: t.durationMs,
              sourceMs: t.sourceMs,
              inMs: t.inMs,
              crop: driverAperture(driverFrame, await this.frame(course.id, t.asset)),
            })),
          );
          if (motion) {
            const asset = course.assets.find((a) => a.id === motion.assetId)!;
            const len = asset.info.durationMs!;
            const crop = driverAperture(driverFrame, await this.frame(course.id, asset));
            for (let at = 0; at < cursor; at += len) {
              clips.push({
                file: this.store.assetPath(course.id, motion.assetId),
                startMs: at,
                durationMs: Math.min(len, cursor - at),
                sourceMs: len,
                inMs: 0,
                crop,
              });
              if (!motion.loopable) break;
            }
          }
          const driver = path.join(dir, 'performer.webm'),
            upload = path.join(dir, 'performer-input.mp4');
          const ffmpeg = await this.media.ffmpeg();
          const idlePath = this.store.assetPath(course.id, idle.id);
          if (clips.length) {
            await actorTrack(
              ffmpeg,
              idlePath,
              idle.info.durationMs!,
              driverFrame,
              clips,
              cursor,
              driver,
              signal,
            );
            await matteInput(ffmpeg, driver, upload, undefined, undefined, signal);
          } else {
            await matteInput(ffmpeg, idlePath, upload, idle.info.videoCodec, cursor, signal);
          }
          videoAssetId = await this.cloud.upload(upload, '人物视频');
        } else if (!course.speaker.imageAssetId) throw new Error('图片驱动需要讲师照片');
        const audioId = await this.cloud.upload(voiceTrack, '口播音频');
        const job = await this.cloud.generate(
          {
            kind: model === 'mediakit-lipsync' ? 'lipsync' : 'avatar',
            model,
            audioAssetId: audioId,
            videoAssetId,
            imageAssetId:
              model === 'omnihuman-1.5'
                ? await this.cloud.upload(this.store.assetPath(course.id, course.speaker.imageAssetId!))
                : undefined,
            durationMs: cursor,
            loop: motion?.loopable ?? false,
            fingerprint: driverFrame
              ? fingerprint({ page: slideFingerprint(course, slide, 'video'), driverFrame, native: 1 })
              : slideFingerprint(course, slide, 'video'),
          },
          remaining,
          signal,
          progress,
        );
        const output = path.join(dir, `${slide.id}.mp4`);
        await this.cloud.download(job.outputAssetId!, output);
        const info = await probe(output, this.store.settings().ffprobePath);
        if (driverFrame && (info.width !== driverFrame.width || info.height !== driverFrame.height))
          throw new Error(
            `口型服务将 ${driverFrame.width}×${driverFrame.height} 返回为 ${info.width}×${info.height}，已停止后续抠像与合成。`,
          );
        if (Math.abs((info.durationMs ?? 0) - cursor) > 200)
          throw new Error('人物视频与音频时长差超过 200ms，请核查上游产物');
        progress('为最终口型视频移除背景');
        const actor = await this.matte(course.id, output, job.id, remaining, signal);
        video = this.addArtifact(
          course,
          slide,
          'video',
          this.store.assetPath(course.id, actor.id),
          actor.info.durationMs!,
          model,
          undefined,
          job.id,
        );
      }
      presenter = path.join(dir, 'presenter.webm');
      copyFileSync(this.store.assetPath(course.id, video.assetId), presenter);
    }
    const finalCues = pageCaptionCues(slide.subtitleText, captionParts);
    writeFileSync(path.join(dir, 'cues.json'), JSON.stringify(finalCues));
    progress('本地合成与编码');
    const output = path.join(dir, 'page.mp4');
    const info = await this.media.compose(course, slide, audio, presenter, finalCues, output, signal);
    this.addArtifact(course, slide, 'composition', output, info.durationMs!, cleanPageModel);
  }
  async cutPortrait(courseId: string, sourceId: string) {
    const c = this.store.get(courseId);
    const source = c.assets.find((a) => a.id === sourceId && a.kind === 'image');
    if (!source || (c.speaker.originalPortraitId ?? c.speaker.imageAssetId) !== sourceId)
      throw new Error('讲师原图已更换，请刷新后重试。');
    if (!c.speaker.originalPortraitId && source.name === '讲师透明形象.png')
      throw new Error('旧版仅记录了抠图结果，请重新导入人物原照。');
    const job = await this.cloud.generate(
      {
        kind: 'cutout',
        model: portraitModel,
        imageAssetId: await this.cloud.upload(this.store.assetPath(courseId, source.id)),
        fingerprint: fingerprint({
          courseId,
          source: source.sha256,
          previous: c.speaker.imageAssetId,
          model: portraitModel,
        }),
      },
      { micros: portraitPriceMicros },
      new AbortController().signal,
      () => {},
    );
    const dir = path.join(this.store.courseRoot(courseId), 'portraits');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, job.id + '.png');
    await this.cloud.download(job.outputAssetId!, file);
    const asset = this.store.addAsset(courseId, file, 'image', { warnings: [] }, 'MediaKit 讲师形象.png');
    this.store.mutate(courseId, (draft) => {
      if (
        (draft.speaker.originalPortraitId ?? draft.speaker.imageAssetId) !== sourceId ||
        draft.speaker.imageAssetId !== c.speaker.imageAssetId
      )
        throw new Error('这次抠图期间照片已更换，已保留当前选择。');
      draft.speaker.originalPortraitId = source.id;
      draft.speaker.imageAssetId = asset.id;
    });
    return asset.id;
  }
  async previewVoice(courseId: string) {
    const c = this.store.get(courseId),
      model = c.speech.model,
      voiceId = c.speaker.voiceIds[model];
    if (!voiceId) throw new Error('请先创建或选择音色。');
    const { text, key, name } = voicePreviewFile(model, voiceId);
    const previous = c.assets.find((a) => a.name === name);
    if (previous) return previous.id;
    const job = await this.cloud.generate(
      { kind: 'speech', model, voiceId, text, fingerprint: key },
      { micros: 3000 },
      new AbortController().signal,
      () => {},
    );
    const dir = path.join(this.store.courseRoot(courseId), 'voice');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    await this.cloud.download(job.outputAssetId!, file);
    const asset = this.store.addAsset(courseId, file, 'audio', { warnings: [] });
    this.change();
    return asset.id;
  }
  async cloneVoice(courseId: string) {
    const course = this.store.get(courseId);
    if (!course.speaker.voiceAssetId) throw new Error('请先导入音色参考音频');
    const dir = path.join(this.store.courseRoot(courseId), 'voice');
    mkdirSync(dir, { recursive: true });
    const audio = path.join(dir, 'reference.wav');
    await this.media.normalizeAudio(this.store.assetPath(courseId, course.speaker.voiceAssetId), audio);
    const job = await this.cloud.generate(
      {
        kind: 'clone',
        model: course.speech.model,
        audioAssetId: await this.cloud.upload(audio),
        fingerprint: fingerprint({
          speaker: course.speaker.id,
          asset: course.speaker.voiceAssetId,
          model: course.speech.model,
          attempt: randomUUID(),
        }),
      },
      { micros: 0 },
      new AbortController().signal,
      () => {},
    );
    this.store.mutate(courseId, (c) => {
      c.speaker.voiceIds[course.speech.model] = job.voiceId!;
    });
    this.change();
  }
  private idle(course: Course) {
    const asset = course.assets.find((a) => a.id === course.speaker.idleAssetId);
    if (!asset?.info.transparent || !asset.info.durationMs)
      throw new Error('请在讲师档案导入透明背景的动态待机视频，或为当前待机视频移除背景。');
    return asset;
  }
  private async frame(courseId: string, asset: Asset) {
    const info =
      asset.info.width && asset.info.height
        ? asset.info
        : await probe(this.store.assetPath(courseId, asset.id), this.store.settings().ffprobePath);
    return sourceFrame(info);
  }
  private async checkMotionResolution(file: string, frame: ReturnType<typeof sourceFrame>) {
    const result = await probe(file, this.store.settings().ffprobePath);
    if (!result.width || !result.height || result.width < frame.width || result.height < frame.height)
      throw new Error(
        `动作模型返回 ${result.width}×${result.height}，低于待机参考 ${frame.width}×${frame.height}。已停止后续抠像，可使用原尺寸实拍素材。`,
      );
  }
  private async matte(
    courseId: string,
    input: string,
    key: string,
    budget: { micros: number },
    signal: AbortSignal,
    displayName = '透明人物.webm',
  ) {
    const dir = mkdtempSync(path.join(tmpdir(), 'mooc-matte-'));
    const ffmpeg = await this.media.ffmpeg(),
      ffprobe = this.store.settings().ffprobePath;
    try {
      const original = await probe(input, ffprobe),
        duration = original.durationMs ?? 0;
      if (duration < 40 || duration > maxPresenterVideoMs) throw new Error('请使用一帧至 5 分钟的人物视频。');
      let source = input,
        codec = original.videoCodec;
      if (!(await hasMatte(ffmpeg, input, duration, codec))) {
        const upload = path.join(dir, 'input.mp4');
        if (codec === 'h264' || codec === 'hevc') {
          await run(ffmpeg, ['-v', 'error', '-i', input, '-map', '0:v:0', '-c:v', 'copy', upload], {
            signal,
          });
        } else await matteInput(ffmpeg, input, upload, codec, undefined, signal);
        const submitted = await probe(upload, ffprobe);
        const job = await this.cloud.generate(
          {
            kind: 'matte',
            model: matteModel,
            videoAssetId: await this.cloud.upload(upload),
            durationMs: submitted.durationMs!,
            fingerprint: fingerprint({ courseId, key, matte: 2 }),
          },
          budget,
          signal,
          () => {},
        );
        source = path.join(dir, 'provider-result');
        await this.cloud.download(job.outputAssetId!, source);
        const result = await probe(source, ffprobe);
        if (result.width !== submitted.width || result.height !== submitted.height)
          throw new Error(
            `抠像服务将 ${submitted.width}×${submitted.height} 返回为 ${result.width}×${result.height}，已停止导入。`,
          );
        codec = result.videoCodec;
      }
      return await this.saveTransparentVideo(
        courseId, source, codec, duration, dir, displayName, ffmpeg, signal,
      );
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }
  private async saveTransparentVideo(
    courseId: string, source: string, codec: string | undefined, duration: number,
    dir: string, displayName: string, ffmpeg: string, signal?: AbortSignal,
  ) {
    const out = path.join(dir, 'person.webm');
    if (codec === 'vp9') {
      await run(ffmpeg, ['-v', 'error', '-i', source, '-map', '0:v:0', '-c:v', 'copy', out], { signal });
    } else await normalizeActor(ffmpeg, source, out, codec);
    const info = await probe(out, this.store.settings().ffprobePath);
    if (!info.durationMs || Math.abs(info.durationMs - duration) > 100 || !(await hasMatte(ffmpeg, out, info.durationMs)))
      throw new Error('人物视频缺少有效透明前景或时长不匹配，请检查素材。');
    return this.store.addAsset(courseId, out, 'video', { ...info, transparent: true }, displayName);
  }

  async addLocalMotion(courseId: string, id: string, kind: 'cut' | 'video') {
    const course = this.store.get(courseId);
    const cut = kind === 'cut' ? course.speaker.savedCuts?.find(c => c.id === id) : undefined;
    if (kind === 'cut' && !cut) throw new Error('选段已删除，请重新选择。');
    const source = course.assets.find(a => a.id === (cut?.sourceId ?? id) && a.kind === 'video');
    if (!source) throw new Error('动作源视频缺失。');
    const key = fingerprint({ localMotion: source.sha256, start: cut?.startMs, end: cut?.endMs });
    if (course.speaker.motions.some(m => m.origin === 'local' && m.sourceClip === key)) return course;
    const ffmpeg = await this.media.ffmpeg();
    const input = cut ? await savedCutFile(this.store, courseId, id, async () => ffmpeg) : this.store.assetPath(courseId, id);
    const info = await probe(input, this.store.settings().ffprobePath);
    if (!info.durationMs || info.durationMs < 40 || info.durationMs > maxPresenterVideoMs) throw new Error('请选择一帧至 5 分钟的动作片段。');
    const name = (cut?.name ?? path.parse(source.name).name).slice(0, 60);
    const dir = mkdtempSync(path.join(tmpdir(), 'mooc-library-'));
    try {
      const asset = await this.saveTransparentVideo(courseId, input, info.videoCodec, info.durationMs, dir, name + '.webm', ffmpeg);
      const result = this.store.mutate(courseId, c => {
        if (c.speaker.id !== course.speaker.id || (cut && !c.speaker.savedCuts?.some(x => x.id === id && x.sourceId === cut.sourceId && x.startMs === cut.startMs && x.endMs === cut.endMs))) throw new Error('讲师或选段已更换，请重试。');
        if (c.speaker.motions.some(m => m.origin === 'local' && m.sourceClip === key)) return;
        if (c.speaker.motions.length >= 100) throw new Error('动作库已满。');
        c.speaker.motions.push({ id: randomUUID(), assetId: asset.id, name, sourceClip: key, cutId: cut?.id, origin: 'local', preset: 'explain', reviewed: true, loopable: false, startPose: '', endPose: '', createdAt: new Date().toISOString() });
      });
      this.change();
      return result;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  async importActorVideo(courseId: string, assetId: string, role: 'reference' | 'idle') {
    const course = this.store.get(courseId);
    const source = course.assets.find((a) => a.id === assetId && a.kind === 'video');
    const duration = source?.info.durationMs ?? 0;
    if (!source || duration < 40 || duration > maxPresenterVideoMs)
      throw new Error('请使用一帧至 5 分钟的人物视频。');
    const file = this.store.assetPath(courseId, assetId);
    const ffmpeg = await this.media.ffmpeg();
    const transparent = source.info.transparent ?? await hasMatte(ffmpeg, file, duration, source.info.videoCodec);
    let selected = source;
    if (transparent && !(source.info.videoCodec === 'vp9' && path.extname(file).toLowerCase() === '.webm')) {
      const dir = mkdtempSync(path.join(tmpdir(), 'mooc-import-actor-'));
      try {
        selected = await this.saveTransparentVideo(
          courseId, file, source.info.videoCodec, duration, dir, path.parse(source.name).name + '.webm', ffmpeg,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    const slot = role === 'idle' ? 'idleAssetId' : 'videoAssetId';
    this.store.mutate(courseId, (c) => {
      if (c.speaker.id !== course.speaker.id || c.speaker[slot] !== course.speaker[slot])
        throw new Error('导入期间讲师或人物视频已更换，请重试。');
      c.assets.find((a) => a.id === source.id)!.info.transparent = transparent;
      c.speaker[slot] = selected.id;
    });
    return selected.id;
  }
  async prepareActorVideo(
    courseId: string,
    assetId: string,
    role: 'reference' | 'idle' | 'candidate',
    motionId?: string,
  ) {
    const course = this.store.get(courseId),
      source = course.assets.find((a) => a.id === assetId && a.kind === 'video');
    if (!source?.info.durationMs) throw new Error('请选择有效的人物视频');
    if (source.info.durationMs > maxPresenterVideoMs) throw new Error('人物视频最长支持 5 分钟。');
    let asset = source.info.transparent
      ? source
      : await this.matte(
          courseId,
          this.store.assetPath(courseId, assetId),
          source.sha256,
          { micros: matteCost(source.info.durationMs + 40, await this.frame(courseId, source)) },
          new AbortController().signal,
          path.parse(source.name).name + '（已抠像）.webm',
        );
    if (role === 'idle') {
      const dir = mkdtempSync(path.join(tmpdir(), 'mooc-idle-')),
        file = path.join(dir, 'idle.webm');
      try {
        await idleLoop(
          await this.media.ffmpeg(),
          this.store.assetPath(courseId, asset.id),
          asset.info.durationMs!,
          file,
        );
        asset = this.store.addAsset(
          courseId,
          file,
          'video',
          { ...(await probe(file, this.store.settings().ffprobePath)), transparent: true },
          '动态待机.webm',
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    this.store.mutate(courseId, (c) => {
      if (c.speaker.id !== course.speaker.id) throw new Error('讲师已更换，请重试');
      const slot = role === 'idle' ? 'idleAssetId' : 'videoAssetId';
      if (role !== 'candidate' && c.speaker[slot] !== course.speaker[slot])
        throw new Error('处理期间人物视频已更换，请按当前素材重试。');
      if (role === 'reference') c.speaker.videoAssetId = asset.id;
      else if (role === 'idle') c.speaker.idleAssetId = asset.id;
      else {
        const m = c.speaker.motions.find((m) => m.id === motionId);
        if (motionId && m?.assetId !== assetId) throw new Error('原动作已删除或更换，请刷新动作库。');
        if (m) {
          m.assetId = asset.id;
          m.reviewed = false;
          delete m.idleHash;
        } else
          c.speaker.motions.push({
            id: randomUUID(),
            name: source.name,
            assetId: asset.id,
            preset: 'explain',
            reviewed: false,
            loopable: false,
            startPose: '',
            endPose: '',
            createdAt: new Date().toISOString(),
          });
      }
    });
    return asset.id;
  }
  async generateIdle(courseId: string) {
    const course = this.store.get(courseId);
    const ref = course.assets.find(
      (a) => a.id === (course.speaker.idleAssetId ?? course.speaker.videoAssetId),
    );
    const portrait = course.speaker.imageAssetId;
    if (!portrait || !ref?.info.transparent)
      throw new Error('请先导入人物照片和待机参考视频，或在动作素材中选一段自然呼吸作为待机。');
    const folder = mkdtempSync(path.join(tmpdir(), 'mooc-idle-model-'));
    const frame = await this.frame(courseId, ref);
    const budget = { micros: motionCutSpec(120, frame).budgetMicros },
      signal = new AbortController().signal,
      ffmpeg = await this.media.ffmpeg();
    try {
      const template = path.join(folder, 'template.mp4'),
        anchor = path.join(folder, 'portrait.png');
      await matteInput(ffmpeg, this.store.assetPath(courseId, ref.id), template, ref.info.videoCodec, 6000);
      await run(ffmpeg, [
        '-v',
        'error',
        '-i',
        this.store.assetPath(courseId, portrait),
        '-vf',
        `format=rgba,pad='ceil(max(iw,ih*${frame.width}/${frame.height}))':'ceil(max(ih,iw*${frame.height}/${frame.width}))':(ow-iw)/2:(oh-ih)/2:color=black@0`,
        '-frames:v',
        '1',
        anchor,
      ]);
      const job = await this.cloud.generate(
        {
          kind: 'motion',
          model: 'dreamactor-2.0',
          preset: 'explain',
          imageAssetId: await this.cloud.upload(anchor),
          videoAssetId: await this.cloud.upload(template),
          durationMs: 6000,
          fingerprint: fingerprint({ courseId, type: 'idle-native', portrait, reference: ref.sha256 }),
        },
        budget,
        signal,
        () => {},
      );
      const out = path.join(folder, 'result.mp4');
      await this.cloud.download(job.outputAssetId!, out);
      await this.checkMotionResolution(out, frame);
      const asset = await this.matte(courseId, out, job.id, budget, signal);
      const current = this.store.get(courseId).speaker;
      if (
        current.id !== course.speaker.id ||
        current.imageAssetId !== portrait ||
        current.idleAssetId !== course.speaker.idleAssetId
      )
        throw new Error('生成期间讲师或待机参考已更换，请重新选择。');
      await this.prepareActorVideo(courseId, asset.id, 'idle');
      this.change();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }
  private async joinedMotion(
    course: Course,
    file: string,
    key: string,
    budget: { micros: number },
    cut?: MotionCut,
    legacy = false,
  ) {
    const idle = this.idle(course),
      ffmpeg = await this.media.ffmpeg();
    const selectedMs = cut ? cut.endMs - cut.startMs : undefined;
    const timing = selectedMs === undefined ? undefined : motionCutSpec(selectedMs);
    if (timing) {
      const actual = (await probe(file, this.store.settings().ffprobePath)).durationMs;
      if (!actual || Math.abs(actual - timing.driverMs) > 80)
        throw new Error('动作模型返回的时长与驱动模板不符，无法定位所选动作。');
    }
    const frame = await this.frame(course.id, idle);
    if (!legacy) await this.checkMotionResolution(file, frame);
    const asset = await this.matte(course.id, file, key, budget, new AbortController().signal);
    const duration = selectedMs ?? asset.info.durationMs!;
    // Include the generated approach and return, then fit them into the exact frame length selected on the rail.
    const handleFrames = timing ? Math.min(6, Math.floor(timing.gestureFrames / 6)) : 0;
    const clip = {
      file: this.store.assetPath(course.id, asset.id),
      startMs: 0,
      durationMs: duration,
      inMs: timing ? (timing.leadFrames - handleFrames) * 40 : 0,
      sourceMs: duration + handleFrames * 80,
      matchIdleEnds: true,
      crop: legacy ? driverAperture(frame, asset.info) : undefined,
    };
    const output = path.join(path.dirname(file), 'joined.webm');
    await actorTrack(
      ffmpeg,
      this.store.assetPath(course.id, idle.id),
      idle.info.durationMs!,
      frame,
      [clip],
      duration,
      output,
    );
    const info = await probe(output, this.store.settings().ffprobePath);
    if (info.durationMs !== snapMs(duration) || !(await hasMatte(ffmpeg, output, duration)))
      throw new Error('动作衔接结果的时长或透明通道校验失败。');
    return this.store.addAsset(course.id, output, 'video', { ...info, transparent: true });
  }

  createMotionFromCut(courseId: string, input: MotionCut, budgetMicros: number): Promise<Course> {
    const course = this.store.get(courseId);
    const cut = {
      sourceId: input.sourceId,
      name: input.name.trim(),
      startMs: snapMs(input.startMs),
      endMs: snapMs(input.endMs),
    };
    if (!cut.name || cut.name.length > 60) throw new Error('请输入 1–60 字的动作名称。');
    const savedCut = findSavedCut(course, cut);
    const source = course.assets.find((a) => a.id === cut.sourceId && a.kind === 'video');
    if (
      (!savedCut && course.speaker.videoAssetId !== cut.sourceId) ||
      !source?.info.transparent ||
      !source.info.durationMs
    )
      throw new Error('人物动作视频已更换或尚未抠像，请重新选择。');
    const rangeMs = cut.endMs - cut.startMs;
    if (input.startMs < 0 || input.endMs > source.info.durationMs || cut.endMs > source.info.durationMs)
      throw new Error('所选时间超出原视频范围，请重新选择。');
    motionCutSpec(rangeMs);
    const idle = this.idle(course);
    const key = fingerprint({
      courseId,
      speaker: course.speaker.id,
      idle: idle.sha256,
      cut,
      source: source.sha256,
      nativeFrame: 1,
    });
    const active = this.cutting.get(courseId);
    if (active?.selectionKey === key) return active.result;
    if (active) throw new Error('本课程有动作正在生成，请等待完成后再提交。');
    const existing = course.speaker.motions.find(
      (m) => m.origin !== 'local' && readyMotion(course, m) && (m.sourceClip === key || (savedCut && m.cutId === savedCut.id)),
    );
    if (existing) {
      if (savedCut && existing.cutId !== savedCut.id)
        return Promise.resolve(
          this.store.mutate(courseId, (c) => {
            c.speaker.motions.find((m) => m.id === existing.id)!.cutId = savedCut.id;
          }),
        );
      return Promise.resolve(course);
    }
    if (course.speaker.motions.length >= 100) throw new Error('动作库已满，请先移除不再使用的动作。');
    const task = this.renderMotion(course, 'explain', budgetMicros, source.id, cut, key)
      .then(() => this.store.get(courseId))
      .finally(() => {
        this.cutting.delete(courseId);
      });
    this.cutting.set(courseId, { selectionKey: key, result: task });
    return task;
  }

  async motion(courseId: string, preset: MotionPreset, budgetMicros: number, referenceId?: string) {
    await this.renderMotion(this.store.get(courseId), preset, budgetMicros, referenceId);
  }

  private async renderMotion(
    course: Course,
    preset: MotionPreset,
    budgetMicros: number,
    referenceId?: string,
    cut?: MotionCut,
    selectionKey?: string,
  ) {
    const courseId = course.id,
      idle = this.idle(course),
      idleFile = this.store.assetPath(courseId, idle.id);
    const ffmpeg = await this.media.ffmpeg();
    const dir = mkdtempSync(path.join(tmpdir(), 'mooc-generate-motion-'));
    const budget = { micros: budgetMicros };
    try {
      const anchor = path.join(dir, 'anchor.png');
      await run(ffmpeg, [
        '-v',
        'error',
        ...actorInput(idleFile),
        '-vf',
        'format=rgba',
        '-frames:v',
        '1',
        anchor,
      ]);
      let driverId: string | undefined;
      let durationMs = 6000;
      if (referenceId) {
        const ref = course.assets.find((a) => a.id === referenceId && a.info.transparent);
        if (!ref?.info.durationMs) throw new Error('请先完成人物动作视频抠像。');
        const length = cut ? cut.endMs - cut.startMs : ref.info.durationMs;
        durationMs = motionCutSpec(length).driverMs;
        const driver = path.join(dir, 'driver.mp4');
        await guidedTemplate(
          ffmpeg,
          idleFile,
          this.store.assetPath(courseId, ref.id),
          length,
          driver,
          idle.info.durationMs!,
          await this.frame(course.id, idle),
          cut?.startMs,
        );
        if ((await probe(driver, this.store.settings().ffprobePath)).durationMs !== durationMs)
          throw new Error('动作驱动模板时长与选区不符，请重新选择。');
        driverId = await this.cloud.upload(driver);
      }
      const job = await this.cloud.generate(
        {
          kind: 'motion',
          videoAssetId: driverId,
          model: 'dreamactor-2.0',
          imageAssetId: await this.cloud.upload(anchor),
          preset,
          durationMs,
          fingerprint: fingerprint({
            courseId,
            speaker: course.speaker.id,
            idle: idle.sha256,
            preset,
            referenceId,
            start: cut?.startMs,
            end: cut?.endMs,
            version: 5,
            take: cut
              ? 0
              : course.speaker.motions.filter((m) => m.idleHash === idle.sha256 && m.preset === preset)
                  .length,
          }),
        },
        budget,
        new AbortController().signal,
        () => {},
      );
      this.store.setRemote('motion-idle:' + job.id, idle.sha256, course.id);
      this.store.setRemote('motion-frame:' + job.id, 'native', course.id);
      if (cut)
        this.store.setRemote(
          'motion-cut:' + job.id,
          JSON.stringify({ cut, selectionKey, speakerId: course.speaker.id, courseId }),
          course.id,
        );
      await this.finishMotion(course, job, dir, budget, preset, referenceId, cut, selectionKey);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private async finishMotion(
    course: Course,
    job: CloudJob,
    dir: string,
    budget: { micros: number },
    preset: MotionPreset,
    referenceId?: string,
    cut?: MotionCut,
    selectionKey?: string,
  ) {
    const idle = this.idle(course);
    const assertCurrent = (c: Course) => {
      if (
        c.speaker.id !== course.speaker.id ||
        c.speaker.idleAssetId !== idle.id ||
        (cut && c.speaker.videoAssetId !== cut.sourceId && !findSavedCut(c, cut))
      )
        throw new Error('制作期间讲师、待机或原视频已更换，请回到对应档案再试。');
    };
    assertCurrent(this.store.get(course.id));
    const file = path.join(dir, 'result.mp4');
    await this.cloud.download(job.outputAssetId!, file);
    const asset = await this.joinedMotion(
      course,
      file,
      job.id,
      budget,
      cut,
      this.store.remote('motion-frame:' + job.id) !== 'native',
    );
    this.store.mutate(course.id, (c) => {
      assertCurrent(c);
      if (
        c.speaker.motions.some((m) => (selectionKey ? m.sourceClip === selectionKey : m.assetId === asset.id))
      )
        return;
      if (c.speaker.motions.length >= 100) throw new Error('动作库已满，请先移除不再使用的动作。');
      c.speaker.motions.push({
        id: randomUUID(),
        name:
          cut?.name ??
          (referenceId
            ? course.speaker.name +
              ' · ' +
              (course.speaker.motions.find((m) => m.assetId === referenceId)?.name ?? '参考动作')
            : motionPresets[preset]),
        preset,
        assetId: asset.id,
        reviewed: !!cut,
        idleHash: idle.sha256,
        sourceClip: selectionKey,
        cutId: cut && findSavedCut(c, cut)?.id,
        referenceHash: course.assets.find((a) => a.id === referenceId)?.sha256,
        loopable: false,
        startPose: '动态待机',
        endPose: '动态待机',
        createdAt: new Date().toISOString(),
      });
    });
    this.change();
  }
  async recoverCloudResult(courseId: string, jobId: string) {
    const course = this.store.get(courseId);
    const job = await this.cloud.request<import('../shared/types').CloudJob>(`/jobs/${jobId}`);
    if (job.status !== 'succeeded') throw new Error('只有已完成的任务可以恢复结果');
    if (
      job.kind === 'clone' &&
      job.voiceId &&
      ['cosyvoice-v3.5-flash', 'cosyvoice-v3.5-plus'].includes(job.model)
    ) {
      await this.cloud.request(`/voices/${encodeURIComponent(job.voiceId)}`);
      this.store.mutate(courseId, (c) => {
        c.speaker.voiceIds[job.model as keyof typeof c.speaker.voiceIds] = job.voiceId!;
      });
    } else if (job.kind === 'motion' && job.outputAssetId) {
      const binding = this.store.remote('motion-idle:' + job.id);
      if (binding !== this.idle(course).sha256)
        throw new Error('此任务的原始待机绑定不可用，请按当前待机重新制作。');
      const saved = this.store.remote('motion-cut:' + job.id);
      const selection = saved
        ? (JSON.parse(saved) as { cut: MotionCut; selectionKey: string; courseId: string; speakerId: string })
        : undefined;
      if (selection && (selection.courseId !== courseId || selection.speakerId !== course.speaker.id))
        throw new Error('请在生成动作时的讲师档案中恢复。');
      if (selection && course.speaker.motions.some((m) => m.sourceClip === selection.selectionKey))
        return course;
      const dir = mkdtempSync(path.join(tmpdir(), 'mooc-restore-motion-'));
      try {
        const duration = selection
          ? motionCutSpec(selection.cut.endMs - selection.cut.startMs).driverMs
          : 6000;
        await this.finishMotion(
          course,
          job,
          dir,
          { micros: matteCost(duration + 80, await this.frame(courseId, this.idle(course))) },
          job.preset ?? 'explain',
          selection?.cut.sourceId,
          selection?.cut,
          selection?.selectionKey,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } else throw new Error('此任务由课程页面恢复：返回对应页重新生成即可复用已完成结果');
    this.change();
    return this.store.get(courseId);
  }
}
