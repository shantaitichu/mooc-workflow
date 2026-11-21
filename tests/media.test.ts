import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceStore } from '../desktop/store';
import { alphaEncode } from '../desktop/actor-video';
import { MediaEngine, probe } from '../desktop/media';
import { run } from '../desktop/process';
import { newSlide, updateNarration, slideFingerprint } from '../shared/domain';
import { createCanvas, loadImage } from '@napi-rs/canvas';

import { ffmpeg, ffprobe } from './media-tools';
test(
  '真实 FFmpeg 合成 1080p 成片、字幕、音频与可恢复工程',
  { skip: !existsSync(ffmpeg), timeout: 180000 },
  async () => {
    mkdirSync('.data', { recursive: true });
    const root = mkdtempSync(path.resolve('.data/media-'));
    const store = new WorkspaceStore(root);
    try {
      store.saveSettings({ ...store.settings(), ffmpegPath: ffmpeg, ffprobePath: ffprobe });
      let course = store.create('本地合成验收');
      course.composition.layout = 'slides';
      course.slides = [
        updateNarration(newSlide('第一章：课程导入'), '这是第一段。'),
        updateNarration(newSlide('第二章：核心概念'), '这是第二段。'),
      ];
      course = store.save(course);
      const media = new MediaEngine(store);
      const input = path.join(root, 'reference.wav');
      await run(ffmpeg, [
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000:duration=1.23',
        '-ac',
        '1',
        input,
      ]);
      for (const slide of course.slides) {
        const dir = path.join(store.courseRoot(course.id), 'renders', slideFingerprint(course, slide));
        mkdirSync(dir, { recursive: true });
        const audio = path.join(dir, 'page.wav');
        await media.concatAudio([input], audio, 600);
        const output = path.join(dir, 'page.mp4');
        const cues = [{ startMs: 0, endMs: 1230, text: slide.spokenText }];
        writeFileSync(path.join(dir, 'cues.json'), JSON.stringify(cues));
        const info = await media.compose(course, slide, audio, undefined, cues, output);
        assert.equal(info.width, 1920);
        assert.equal(info.height, 1080);
        assert.equal(info.fps, 25);
        assert.ok(info.hasAudio);
        assert.ok(Math.abs(info.durationMs! - 1840) <= 40);
        const asset = store.addAsset(course.id, output, 'video', info);
        const artifact = {
          id: randomUUID(),
          slideId: slide.id,
          stage: 'composition' as const,
          fingerprint: slideFingerprint(course, slide),
          assetId: asset.id,
          durationMs: info.durationMs!,
          createdAt: new Date().toISOString(),
          model: 'ffmpeg-test',
        };
        store.mutate(course.id, (c) => {
          c.artifacts.push(artifact);
          c.slides.find((s) => s.id === slide.id)!.reviewedFingerprint = artifact.fingerprint;
        });
      }
      course = store.get(course.id);
      const destination = path.join(root, 'export');
      const output = await media.export(course, destination, {
        subtitles: true,
        audio: true,
        project: true,
        perSlide: true,
      });
      const info = await probe(output, ffprobe);
      assert.ok(Math.abs(info.durationMs! - 3680) <= 60);
      assert.ok(existsSync(path.join(destination, 'narration.wav')));
      assert.ok(existsSync(path.join(destination, 'project.mooc')));
      assert.match(readFileSync(path.join(destination, 'subtitles.srt'), 'utf8'), /00:00:01,840/);
      await run(ffmpeg, [
        '-y',
        '-v',
        'error',
        '-i',
        output,
        '-frames:v',
        '1',
        path.resolve('.data/rendered-frame.png'),
      ]);
      const firstFrame = await loadImage(path.resolve('.data/rendered-frame.png'));
      const ctx = createCanvas(1920, 1080).getContext('2d');
      ctx.drawImage(firstFrame, 0, 0);
      const corner = ctx.getImageData(50, 50, 1, 1).data;
      assert.ok(
        [...corner].every((component) => component > 245),
        '新建项目默认应导出白色画布',
      );
      const title = ctx.getImageData(100, 270, 800, 110).data;
      assert.ok(
        title.some((component, i) => i % 4 === 0 && component < 75),
        '白画布上的页面标题应可读',
      );
      const restored = store.importArchive(path.join(destination, 'project.mooc'));
      assert.equal(restored.slides.length, 2);
      // A different subtitle export is a local-only render and retains all generation artifacts.
      const before = course.artifacts.length;
      await media.export(course, path.join(root, 'clean'), {
        subtitles: false,
        audio: false,
        project: false,
        perSlide: false,
      });
      assert.equal(store.get(course.id).artifacts.length, before);
      await media.export(restored, path.join(root, 'restored-clean'), {
        subtitles: false,
        audio: true,
        project: false,
        perSlide: false,
      });
      assert.equal(
        readFileSync(path.join(root, 'restored-clean/subtitles.srt'), 'utf8'),
        readFileSync(path.join(destination, 'subtitles.srt'), 'utf8'),
      );
    } finally {
      store.close();
    }
  },
);

test(
  '1080p 成片保留画布颜色、PPT 比例与位置、人物叠放和背景选段循环',
  { skip: !existsSync(ffmpeg), timeout: 120000 },
  async () => {
    const root = mkdtempSync(path.resolve('.data-test-')),
      store = new WorkspaceStore(root);
    try {
      store.saveSettings({ ...store.settings(), ffmpegPath: ffmpeg, ffprobePath: ffprobe });
      const media = new MediaEngine(store);
      let c = store.create('背景循环验收');
      const bg = path.join(root, 'red-blue.webm');
      await run(ffmpeg, [
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=red:s=180x180:d=1:r=25',
        '-f',
        'lavfi',
        '-i',
        'color=blue:s=180x180:d=1:r=25',
        '-f',
        'lavfi',
        '-i',
        'color=white:s=180x180:d=2:r=25,format=gray,drawbox=x=0:y=145:w=180:h=35:color=black:t=fill',
        '-filter_complex',
        '[0:v][1:v]concat=n=2:v=1:a=0[color];[color][2:v]alphamerge[v]',
        '-map',
        '[v]',
        ...alphaEncode,
        bg,
      ]);
      const background = store.addAsset(c.id, bg, 'video', await probe(bg, ffprobe));
      const white = createCanvas(200, 150);
      white.getContext('2d').fillStyle = 'white';
      white.getContext('2d').fillRect(0, 0, white.width, white.height);
      const png = path.join(root, 'slide.png');
      writeFileSync(png, white.toBuffer('image/png'));
      const asset = store.addAsset(c.id, png, 'slide');
      c = store.mutate(c.id, (c) => {
        c.slides.push({
          ...newSlide('背景'),
          assetId: asset.id,
          backgroundAssetId: background.id,
          backgroundStartMs: 500,
          backgroundEndMs: 1500,
          shortBackground: 'loop',
          compositionOverride: {
            deckScale: 50,
            deckLeft: 5,
            deckTop: 25,
            presenterScale: 25,
            presenterX: 52,
            presenterY: 50,
            backgroundColor: '#269466',
          },
        });
      });
      const audio = path.join(root, 'sound.wav');
      await run(ffmpeg, [
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=48000:cl=mono',
        '-t',
        '2.5',
        audio,
      ]);
      const output = path.join(root, 'page.mp4');
      // The presenter uses the full red/blue source; the background repeats only the chosen one-second cut.
      await media.compose(c, c.slides[0], audio, bg, [], output);
      const frame = path.join(root, 'frame.png');
      await run(ffmpeg, ['-y', '-v', 'error', '-ss', '1.12', '-i', output, '-frames:v', '1', frame]);
      const image = await loadImage(frame);
      const canvas = createCanvas(1920, 1080);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      function expectColor(x: number, y: number, expected: number[], message: string) {
        const rgba = ctx.getImageData(x, y, 1, 1).data;
        assert.ok(
          expected.every((component, i) => Math.abs(rgba[i] - component) < 12),
          message,
        );
      }
      const green = [38, 148, 102];
      const red = [255, 0, 0];
      const page = [255, 255, 255];
      // The square background spans x = 420..1500. The page's 4:3 content fits inside the 960×540 box
      // at (96,270), so it spans x = 216..936 and y = 270..810. The presenter overlaps its right edge.
      expectColor(1700, 600, green, '右侧预留区应显示用户所选画布色');
      expectColor(1300, 1000, green, '背景视频的透明像素应透出画布色');
      expectColor(1300, 600, red, '背景第二轮应回到红色');
      expectColor(200, 450, green, '课件须保持原始宽高比');
      expectColor(230, 450, page, '课件左边缘应在用户设置的位置');
      expectColor(550, 250, red, '课件上方应看到视频背景');
      expectColor(550, 285, page, '视频上方应叠放课件');
      expectColor(550, 825, red, '缩小后的课件应在预期位置结束');
      expectColor(830, 530, [0, 0, 255], '讲师应叠放在课件之上');
      const frozen = path.join(root, 'freeze.mp4');
      await media.compose(c, { ...c.slides[0], shortBackground: 'freeze' }, audio, bg, [], frozen);
      const freezeFrame = path.join(root, 'freeze-frame.png');
      await run(ffmpeg, ['-y', '-v', 'error', '-ss', '1.8', '-i', frozen, '-frames:v', '1', freezeFrame]);
      ctx.drawImage(await loadImage(freezeFrame), 0, 0);
      expectColor(1300, 600, [0, 0, 255], '定格背景应保持所选片段的尾帧');
      expectColor(1300, 1000, green, '直接读取背景和定格时也应保留透明区');
    } finally {
      store.close();
    }
  },
);
