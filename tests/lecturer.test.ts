import { readyMotion } from '../shared/domain';
import {
  actorInput,
  actorTrack,
  guidedTemplate,
  hasMatte,
  matteInput,
  alphaEncode,
} from '../desktop/actor-video';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { motionCutSpec } from '../shared/motion-track';
import { driverAperture, fitPresenter } from '../shared/presenter-frame';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { WorkspaceStore } from '../desktop/store';
import { motionIntervals, savedCutFile } from '../desktop/speaker-media';
import { MediaEngine, probe } from '../desktop/media';
import { Production } from '../desktop/production';
import type { CloudClient } from '../desktop/cloud';
import type { GenerationInput } from '../shared/types';
import { newSlide, updateNarration, currentArtifact } from '../shared/domain';
import { batchCourse } from '../shared/production-batches';
import { estimateProduction } from '../shared/estimate';
import { run } from '../desktop/process';
import { ffmpeg, ffprobe } from './media-tools';

test(
  '原尺寸人物驱动保留横竖构图和逐像素细节，高清上传没有 720p 上限',
  { skip: !existsSync(ffmpeg) },
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'native-frame-'));
    try {
      for (const [width, height] of [
        [1920, 1080],
        [1080, 1920],
        [1280, 720],
      ]) {
        const idle = path.join(dir, 'idle.webm'),
          track = path.join(dir, 'track.webm'),
          upload = path.join(dir, 'input.mp4');
        await run(ffmpeg, [
          '-y',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          `testsrc2=s=${width}x${height}:r=25:d=0.12,format=yuva420p,drawbox=w=iw/4:h=ih:color=black@0:t=fill:replace=1`,
          ...alphaEncode,
          idle,
        ]);
        await actorTrack(ffmpeg, idle, 120, { width, height }, [], 120, track);
        const decoded = (file: string) =>
          run(ffmpeg, [
            '-v',
            'error',
            ...actorInput(file),
            '-map',
            '0:v',
            '-pix_fmt',
            'yuva420p',
            '-f',
            'hash',
            '-hash',
            'sha256',
            '-',
          ]);
        assert.equal(await decoded(track), await decoded(idle));
        await matteInput(ffmpeg, track, upload);
        const info = await probe(upload, ffprobe);
        assert.deepEqual([info.width, info.height, info.durationMs], [width, height, 120]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('横向待机和竖向待机沿用原始构图，缩放后的驱动结果保留同一人物框', () => {
  const wide = { width: 1280, height: 720 };
  const driver = { width: 640, height: 960 };
  const crop = driverAperture(wide, driver)!;
  assert.deepEqual(crop, { x: 0, y: 300, w: 640, h: 360 });
  assert.deepEqual(driverAperture(wide, { width: 1280, height: 1920 }), { x: 0, y: 600, w: 1280, h: 720 });
  assert.deepEqual(driverAperture({ width: 540, height: 1080 }, driver), { x: 80, y: 0, w: 480, h: 960 });
  assert.equal(driverAperture(driver, driver), undefined);
  assert.equal(driverAperture(wide, wide), undefined);
  const box = { x: -12, y: 203, w: 1344, h: 880 };
  assert.deepEqual(fitPresenter(box, crop), fitPresenter(box, { w: wide.width, h: wide.height }));
});

test('静止间隔拆成两个候选动作', () => {
  const frames = Buffer.alloc(80 * 60 * 30);
  for (const f of [2, 4, 6, 16, 18, 20]) {
    const y = f < 10 ? 10 : 39;
    for (let row = y; row < y + 8; row++)
      frames.fill(200, f * 4800 + row * 80 + 33, f * 4800 + row * 80 + 45);
  }
  assert.deepEqual(
    motionIntervals(frames, 6).map((c) => c.name),
    ['头部动作', '上身／手势动作'],
  );
});
test(
  '多行讲稿只提交一段整页口型，换行气口进入驱动音频，改版式只重做合成',
  { skip: !existsSync(ffmpeg), timeout: 120000 },
  async () => {
    mkdirSync('.data', { recursive: true });
    const root = mkdtempSync(path.resolve('.data/page-lipsync-')),
      store = new WorkspaceStore(root);
    try {
      store.saveSettings({ ...store.settings(), ffmpegPath: ffmpeg, ffprobePath: ffprobe });
      let c = store.create('单页口型');
      const slide = updateNarration(newSlide('第一页'), '第一行\n第二行');
      const speechFile = path.join(root, 'speech.wav'),
        rawFile = path.join(root, 'raw.mp4');
      await run(ffmpeg, [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=300:duration=0.4',
        '-ar',
        '48000',
        speechFile,
      ]);
      await run(ffmpeg, [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=blue:s=96x128:r=25:d=2',
        '-c:v',
        'libx264',
        rawFile,
      ]);
      const original = store.addAsset(c.id, rawFile, 'video', await probe(rawFile, ffprobe));
      let actorColor = 'blue',
        sourceVideo = '',
        driverMs = 0,
        driverFile = '',
        wrongDuration = true;
      const calls: GenerationInput[] = [];
      let uploads = 0;
      let interruptLip = false;
      const mock = {
        upload: async (file: string) => {
          uploads++;
          const dest = path.join(root, crypto.randomUUID() + path.extname(file));
          copyFileSync(file, dest);
          return dest;
        },
        generate: async (input: GenerationInput) => {
          calls.push(input);
          if (input.kind === 'lipsync') {
            if (interruptLip) {
              interruptLip = false;
              throw new Error('火山 视频素材准备或上传失败 · ECONNRESET');
            }
            sourceVideo = input.videoAssetId!;
            const frame = await probe(sourceVideo, ffprobe);
            assert.deepEqual([frame.width, frame.height, frame.durationMs], [96, 128, 1200]);
          }
          if (input.kind === 'motion') {
            driverFile = input.videoAssetId!;
            driverMs = (await probe(driverFile, ffprobe)).durationMs!;
          }
          return { id: 'test-' + calls.length, outputAssetId: input.kind };
        },
        download: async (kind: string, out: string) => {
          if (kind === 'matte') {
            const secs = calls.at(-1)!.durationMs! / 1000;
            // Animated synthetic foreground with a known transparent border, as returned by a matting provider.
            const filter =
              'color=' +
              actorColor +
              ':s=96x128:r=25:d=' +
              secs +
              ',format=rgba,geq=r=r(X\\,Y):g=g(X\\,Y):b=b(X\\,Y):a=255*between(X\\,23+5*sin(T*6)\\,73)';
            await run(ffmpeg, [
              '-y',
              '-v',
              'error',
              '-f',
              'lavfi',
              '-i',
              filter,
              '-an',
              '-c:v',
              'libvpx-vp9',
              '-pix_fmt',
              'yuva420p',
              '-f',
              'webm',
              out,
            ]);
          } else
            copyFileSync(
              kind === 'speech'
                ? speechFile
                : kind === 'motion'
                  ? wrongDuration
                    ? rawFile
                    : driverFile
                  : sourceVideo,
              out,
            );
        },
      };
      const production = new Production(
        store,
        new MediaEngine(store),
        mock as unknown as CloudClient,
        () => {},
      );
      for (const role of ['reference', 'idle'] as const)
        assert.equal(await production.importActorVideo(c.id, original.id, role), original.id);
      const imported = store.get(c.id);
      assert.equal(imported.speaker.videoAssetId, original.id);
      assert.equal(imported.speaker.idleAssetId, original.id);
      assert.equal(imported.assets.find(a => a.id === original.id)?.info.transparent, false);
      assert.equal(uploads, 0);
      assert.equal(calls.length, 0);
      const idle = await production.prepareActorVideo(c.id, original.id, 'idle');
      actorColor = 'red';
      const matted = await production.prepareActorVideo(c.id, original.id, 'reference');
      assert.deepEqual(calls.map(job => job.kind), ['matte', 'matte']);
      const second = store.create('已有透明视频');
      const transparentFile = store.assetPath(c.id, matted);
      const ready = store.addAsset(second.id, transparentFile, 'video', await probe(transparentFile, ffprobe));
      for (const role of ['reference', 'idle'] as const)
        assert.equal(await production.importActorVideo(second.id, ready.id, role), ready.id);
      assert.equal(store.get(second.id).assets.length, 1);
      assert.equal(store.get(second.id).assets[0].info.transparent, true);
      assert.equal(uploads, 2);
      assert.equal(calls.length, 2);
      c = store.mutate(c.id, (d) => {
        d.speaker.voiceIds[d.speech.model] = 'test';
        d.speech.paragraphPauseMs = 400;
        d.slides = [slide];
        d.composition.layout = 'presenter';
        d.composition.presenterScale = 25;
        d.composition.presenterX = 50;
        d.composition.presenterY = 50;
        d.composition.backgroundColor = '#f4ca1e';
      });
      assert.equal(estimateProduction(c, c.slides).cloudJobs, 4);
      const cut = { sourceId: c.speaker.videoAssetId!, startMs: 120, endMs: 920, name: '举手' };
      const savedCut = { ...cut, id: crypto.randomUUID() };
      c = store.mutate(c.id, d => {
        d.speaker.savedCuts = [savedCut];
        d.speaker.videoAssetId = idle;
      });
      let encodes = 0;
      const reveal = () => savedCutFile(store, c.id, savedCut.id, async () => { encodes++; return ffmpeg; });
      const [clip, concurrent] = await Promise.all([reveal(), reveal()]);
      assert.equal(concurrent, clip);
      assert.equal(await reveal(), clip);
      assert.equal(encodes, 1);
      const clipInfo = await probe(clip, ffprobe);
      assert.deepEqual([clipInfo.width, clipInfo.height, clipInfo.durationMs], [96, 128, 800]);
      const hashFrames = (file: string, filters: string[]) => run(ffmpeg, [
        '-v', 'error', ...actorInput(file), ...filters, '-an', '-pix_fmt', 'yuva420p', '-f', 'hash', '-hash', 'sha256', '-',
      ]);
      assert.equal(await hashFrames(clip, []), await hashFrames(store.assetPath(c.id, cut.sourceId),
        ['-vf', 'trim=start_frame=3:end_frame=23,setpts=PTS-STARTPTS']));
      await assert.rejects(production.createMotionFromCut(c.id, cut, 3110000), /时长/);
      assert.equal(store.get(c.id).speaker.motions.length, 0);
      assert.deepEqual(store.get(c.id).speaker.savedCuts, [savedCut]);
      wrongDuration = false;
      const generating = production.createMotionFromCut(c.id, cut, 3110000);
      assert.equal(production.createMotionFromCut(c.id, cut, 3110000), generating);
      c = await generating;
      assert.equal(driverMs, 6000);
      assert.equal(c.speaker.motions.length, 1);
      const generated = c.speaker.motions[0];
      assert.equal(generated.cutId, savedCut.id);
      assert.equal(generated.reviewed, true);
      assert.equal(generated.name, '举手');
      assert.ok(readyMotion(c, generated));
      assert.equal((await probe(store.assetPath(c.id, generated.assetId), ffprobe)).durationMs, 800);
      const paid = calls.length;
      await production.createMotionFromCut(c.id, cut, 3110000);
      assert.equal(calls.length, paid);
      c = store.mutate(c.id, (d) => {
        d.slides[0].motionTrack = [{ id: crypto.randomUUID(), motionId: generated.id, startMs: 200 }];
      });
      async function make(batchId?: string, operation?: 'resume' | 'audio' | 'video', expected = 'completed') {
        const id = await production.start({
          courseId: c.id,
          slideIds: [slide.id],
          sample: true,
          budgetMicros: 3000000, batchId, operation,
        });
        let task = store.tasks().find((t) => t.id === id)!;
        while (task.status === 'running') {
          await new Promise((r) => setTimeout(r, 100));
          task = store.tasks().find((t) => t.id === id)!;
        }
        assert.equal(task.status, expected, task.message);
      }
      actorColor = 'blue';
      await make();
      assert.equal(calls.filter((j) => j.kind === 'lipsync').length, 1);
      c = store.get(c.id);
      const actor = currentArtifact(c, c.slides[0], 'video')!;
      assert.ok(await hasMatte(ffmpeg, store.assetPath(c.id, actor.assetId), 1200));
      const page = currentArtifact(c, c.slides[0], 'composition')!,
        file = store.assetPath(c.id, page.assetId);
      async function rgb(input: string, at: number, x: number, y: number) {
        const dest = path.join(root, 'pixel.rgb');
        await run(ffmpeg, [
          '-y',
          '-v',
          'error',
          '-ss',
          String(at),
          ...actorInput(input),
          '-vf',
          'crop=2:2:' + x + ':' + y + ',scale=1:1',
          '-frames:v',
          '1',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          dest,
        ]);
        return [...readFileSync(dest)];
      }
      // Both samples lie inside the presenter's on-slide bounding box.
      for (const t of [0.04, 0.6, 1.44]) {
        const [r, g, b] = await rgb(file, t, 738, 540);
        assert.ok(r > 190 && g > 150 && b < 90, 'transparent border failed: ' + [r, g, b]);
        const [red, , blue] = await rgb(file, t, 960, 540);
        assert.ok(blue > red + 100, 'missing presenter');
      }
      const motionFile = store.assetPath(c.id, generated.assetId);
      for (const [t, color] of [
        [0, 'blue'],
        [0.4, 'red'],
        [0.76, 'blue'],
      ] as const) {
        const [r, , b] = await rgb(motionFile, t, 48, 64);
        assert.ok(color === 'blue' ? b > r + 100 : r > b + 100, 'motion boundary color: ' + [t, r, b]);
      }
      const idleFile = store.assetPath(c.id, idle);
      assert.ok(await hasMatte(ffmpeg, idleFile, 2000));
      const count = calls.length;
      store.mutate(c.id, (d) => {
        d.slides[0].compositionOverride = { presenterX: -20 };
      });
      await make();
      assert.equal(calls.length, count);
      store.mutate(c.id, (d) => {
        d.slides[0].videoTake = 1;
      });
      await make();
      assert.deepEqual(
        calls.slice(count).map((job) => job.kind),
        ['lipsync', 'matte'],
      );
      const beforeRepair = store.get(c.id);
      const groups = beforeRepair.batches!;
      assert.equal(groups.length, 3);
      const initialComposition = currentArtifact(beforeRepair, beforeRepair.slides[0], 'composition')!;
      const startRepair = calls.length;
      await make(groups[0].id, 'audio');
      let repaired = store.get(c.id);
      assert.equal(repaired.batches!.length, 3);
      assert.deepEqual(repaired.batches!.slice(1), groups.slice(1));
      let isolated = batchCourse(repaired, repaired.batches![0]);
      assert.ok(currentArtifact(isolated, isolated.slides[0], 'audio'));
      assert.equal(currentArtifact(isolated, isolated.slides[0], 'video'), undefined);
      assert.equal(currentArtifact(isolated, isolated.slides[0], 'composition'), undefined);
      assert.ok(calls.slice(startRepair).every(call => call.kind === 'speech'));
      assert.equal(currentArtifact(repaired, repaired.slides[0], 'composition')?.id, initialComposition.id);
      const afterAudio = calls.length;
      await make(groups[0].id, 'resume');
      repaired = store.get(c.id);
      isolated = batchCourse(repaired, repaired.batches![0]);
      assert.deepEqual(calls.slice(afterAudio).map(call => call.kind), ['lipsync','matte']);
      assert.ok(currentArtifact(isolated, isolated.slides[0], 'composition'));
      assert.deepEqual(repaired.batches!.slice(1), groups.slice(1));
      const afterResume = calls.length;
      interruptLip = true;
      await make(groups[0].id, 'video', 'failed');
      const failed = store.get(c.id);
      assert.match(failed.batches![0].pages[0].error!, /视频.*ECONNRESET/);
      const failedContext = batchCourse(failed, failed.batches![0]);
      assert.ok(currentArtifact(failedContext, failedContext.slides[0], 'audio'));
      assert.equal(currentArtifact(failedContext, failedContext.slides[0], 'video'), undefined);
      assert.ok(currentArtifact(failedContext, failed.batches![0].pages[0].slide, 'composition'));
      await make(groups[0].id, 'resume');
      assert.equal(store.get(c.id).batches![0].pages[0].error, undefined);
      assert.deepEqual(calls.slice(afterResume).map(call => call.kind), ['lipsync','lipsync','matte']);
      assert.deepEqual(store.get(c.id).batches!.slice(1), groups.slice(1));
      const photo = path.join(root, 'portrait.png');
      await run(ffmpeg, ['-v', 'error', ...actorInput(idleFile), '-frames:v', '1', photo]);
      const photoAsset = store.addAsset(c.id, photo, 'image', { warnings: [] });
      store.mutate(c.id, (d) => {
        d.speaker.imageAssetId = photoAsset.id;
      });
      actorColor = 'red';
      await production.generateIdle(c.id);
      const updated = store.get(c.id);
      assert.notEqual(updated.speaker.idleAssetId, idle);
      assert.equal(calls.at(-2)?.kind, 'motion');
      assert.equal(calls.at(-1)?.kind, 'matte');
      assert.ok(!readyMotion(updated, generated));
    } finally {
      store.close();
    }
  },
);

test('长动作模板按入点取材并保留片段尾部，首尾使用待机参考', { skip: !existsSync(ffmpeg) }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mooc-driver-seek-'));
  const idle = path.join(dir, 'idle.mov'),
    source = path.join(dir, 'source.mov'),
    out = path.join(dir, 'driver.mp4');
  try {
    await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=64x96:d=1', '-c:v', 'qtrle', idle]);
    // Outside the selection is red. Its last second is yellow and must survive past the old six-second template.
    await run(ffmpeg, [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      "color=red:s=64x96:d=10,drawbox=w=iw:h=ih:color=lime:t=fill:enable='between(t,2,8)',drawbox=w=iw:h=ih:color=yellow:t=fill:enable='between(t,8,9)'",
      '-c:v',
      'qtrle',
      source,
    ]);
    const timing = motionCutSpec(7000);
    await guidedTemplate(ffmpeg, idle, source, 7000, out, 1000, { width: 64, height: 96 }, 2000);
    assert.equal((await probe(out, ffprobe)).durationMs, timing.driverMs);
    const rgbFile = path.join(dir, 'pixel.rgb');
    for (const [at, color] of [
      [0, 'blue'],
      [1, 'green'],
      [7.1, 'yellow'],
      [8.16, 'blue'],
    ] as const) {
      await run(ffmpeg, [
        '-y',
        '-v',
        'error',
        '-ss',
        String(at),
        '-i',
        out,
        '-vf',
        'crop=2:2:32:48,scale=1:1',
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        rgbFile,
      ]);
      const [r, g, b] = readFileSync(rgbFile);
      assert.ok(
        color === 'blue'
          ? b > 200 && g < 20
          : color === 'yellow'
            ? r > 200 && g > 200 && b < 20
            : g > 200 && r < 20,
        at + ': ' + [r, g, b],
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
