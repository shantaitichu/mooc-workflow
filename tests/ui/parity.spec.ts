import { createCanvas, loadImage } from '@napi-rs/canvas';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { actorInput, alphaEncode } from '../../desktop/actor-video';
import { probe } from '../../desktop/media';
import { run } from '../../desktop/process';
import { WorkspaceStore } from '../../desktop/store';
import { newSlide, slideFingerprint, updateNarration } from '../../shared/domain';
import { ffmpeg, ffprobe } from '../media-tools';
import { launchDesktop } from './launch-desktop';

const caption = '首先来看时间上的累积。';

async function captureStage(app: ElectronApplication, page: Page) {
  const stage = page.locator('.layout-stage');
  await stage.scrollIntoViewIfNeeded();
  await expect
    .poll(() => stage.locator('video').evaluate((el: HTMLVideoElement) => el.readyState))
    .toBeGreaterThanOrEqual(2);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect(page.getByLabel('播放头', { exact: true })).toHaveAttribute('aria-valuenow', '0');
  await page.mouse.move(0, 0);
  const bounds = await stage.boundingBox();
  if (!bounds) throw new Error('找不到当前页的实时预览');
  const rect = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
  const png = await app.evaluate(async ({ BrowserWindow }, rect) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(rect, {
      stayAwake: true,
      stayHidden: true,
    });
    return image.toPNG().toString('base64');
  }, rect);
  return Buffer.from(png, 'base64');
}

async function measure(png: Buffer) {
  const image = await loadImage(png);
  const ctx = createCanvas(1920, 1080).getContext('2d');
  ctx.drawImage(image, 0, 0, 1920, 1080);
  const { data } = ctx.getImageData(0, 0, 1920, 1080);
  const actor = [1920, 1080, -1, -1];
  const subtitle = [...actor];
  for (let y = 100; y < 1080; y++) {
    for (let x = 0; x < 1920; x++) {
      const i = (y * 1920 + x) * 4;
      const r = data[i],
        g = data[i + 1],
        b = data[i + 2];
      let box: number[];
      if (r > 160 && g < 100 && b > 135) box = actor;
      else if (x > 450 && x < 1450 && y > 725 && r > 190 && g > 190 && b > 190) box = subtitle;
      else continue;
      box[0] = Math.min(box[0], x);
      box[1] = Math.min(box[1], y);
      box[2] = Math.max(box[2], x);
      box[3] = Math.max(box[3], y);
    }
  }
  expect(actor[2] - actor[0], '预览／成片未出现测试人物').toBeGreaterThan(30);
  expect(subtitle[2] - subtitle[0], '预览／成片未出现已确认的字幕').toBeGreaterThan(50);
  return { actor, subtitle };
}

function compare(actual: number[], expected: number[], label: string) {
  // The live workbench is displayed at desktop preview resolution, then mapped back to 1080p.
  const delta = Math.max(...actual.map((value, i) => Math.abs(value - expected[i])));
  expect.soft(delta, label + '：' + actual.join(',') + ' / ' + expected.join(',')).toBeLessThanOrEqual(5);
}

test('同一页首帧在生成前、复用旧口型后的预览及导出 MP4 中保持人物与字幕的位置大小', async () => {
  test.setTimeout(120000);
  mkdirSync('.data', { recursive: true });
  const dir = mkdtempSync(path.resolve('.data/ui-parity-'));
  const store = new WorkspaceStore(path.join(dir, 'workspace'));
  let app: ElectronApplication | undefined;
  try {
    store.saveSettings({ ...store.settings(), ffmpegPath: ffmpeg, ffprobePath: ffprobe });
    const course = store.create('画面一致性验收');
    const silhouette = createCanvas(1280, 720);
    const brush = silhouette.getContext('2d');
    brush.fillStyle = '#ee29cd';
    brush.beginPath();
    brush.arc(736, 196, 64, 0, Math.PI * 2);
    brush.fill();
    brush.fillRect(608, 250, 256, 434);
    brush.fillRect(568, 320, 336, 60);
    const portrait = path.join(dir, 'silhouette.png');
    writeFileSync(portrait, silhouette.toBuffer('image/png'));
    const idleFile = path.join(dir, 'idle.webm');
    const voiceFile = path.join(dir, 'voice.wav');
    await run(ffmpeg, ['-v', 'error', '-loop', '1', '-i', portrait, '-t', '1.2', ...alphaEncode, idleFile]);
    await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=240:duration=1.2', voiceFile]);
    const idle = store.addAsset(course.id, idleFile, 'video', {
      ...(await probe(idleFile, ffprobe)),
      transparent: true,
    });
    const voice = store.addAsset(course.id, voiceFile, 'audio', await probe(voiceFile, ffprobe));
    const deck = createCanvas(640, 360);
    const panel = deck.getContext('2d');
    panel.fillStyle = '#54838e';
    panel.fillRect(0, 0, 640, 360);
    panel.fillStyle = '#284454';
    panel.fillRect(50, 60, 300, 20);
    const pageFile = path.join(dir, 'page.png');
    writeFileSync(pageFile, deck.toBuffer('image/png'));
    const slide = updateNarration(newSlide('第一讲'), caption, caption);
    slide.assetId = store.addAsset(course.id, pageFile, 'slide').id;
    slide.recordedAudioId = voice.id;
    slide.pagePauseMs = 0;
    const legacyFile = path.join(dir, 'cached-output.webm');
    // Historical MediaKit drivers fitted this landscape recording inside a fixed portrait canvas.
    await run(ffmpeg, [
      '-v',
      'error',
      ...actorInput(idleFile),
      '-vf',
      'scale=640:360,format=yuva420p,pad=640:960:0:300:color=black@0',
      ...alphaEncode,
      legacyFile,
    ]);
    const legacy = store.addAsset(course.id, legacyFile, 'video', {
      ...(await probe(legacyFile, ffprobe)),
      transparent: true,
    });
    store.mutate(course.id, (c) => {
      c.speaker.idleAssetId = idle.id;
      c.slides = [slide];
      Object.assign(c.composition, {
        presenterScale: 70,
        presenterX: 100,
        presenterY: 95,
        subtitleSize: 48,
        subtitleBottom: 13,
        backgroundColor: '#293949',
        deckScale: 58,
        deckLeft: 2,
        deckTop: 7,
      });
    });
    app = await launchDesktop(dir);
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false),
    );
    await page.getByRole('button', { name: '画面设置', exact: true }).click();
    const beforePng = await captureStage(app, page);
    const before = await measure(beforePng);
    writeFileSync(path.join(dir, 'before.png'), beforePng);
    // Original 1280×720 recording fits to 1344×756 at (576,252); retain its asymmetric transparent border.
    compare(before.actor, [1172, 391, 1524, 969], '按用户设置摆放的原始待机大小');
    store.mutate(course.id, (c) => {
      c.artifacts.push({
        id: crypto.randomUUID(),
        slideId: slide.id,
        stage: 'video',
        assetId: legacy.id,
        fingerprint: slideFingerprint(c, c.slides[0], 'video'),
        model: 'mediakit-lipsync',
        createdAt: new Date().toISOString(),
        durationMs: 1200,
        sourceJobId: crypto.randomUUID(),
      });
    });
    const taskId = await page.evaluate(
      async ({ courseId, slideId }) =>
        window.mooc!.produce({
          courseId,
          slideIds: [slideId],
          budgetMicros: 0,
          sample: true,
        }),
      { courseId: course.id, slideId: slide.id },
    );
    await expect
      .poll(() => store.tasks().find((t) => t.id === taskId)?.status, { timeout: 45000 })
      .not.toBe('running');
    const task = store.tasks().find((t) => t.id === taskId)!;
    expect(task.status, task.message).toBe('completed');
    await expect
      .poll(() => page.locator('.layout-stage video').evaluate((v: HTMLVideoElement) => v.currentSrc))
      .not.toContain(idle.id);
    const afterPng = await captureStage(app, page);
    writeFileSync(path.join(dir, 'after.png'), afterPng);
    const after = await measure(afterPng);
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, dir);
    const mp4 = await page.evaluate(
      (id) =>
        window.mooc!.exportCourse(id, {
          allowUnreviewed: true,
          subtitles: true,
          perSlide: false,
          audio: false,
          project: false,
        }),
      course.id,
    );
    if (!mp4) throw new Error('未导出成片');
    const frame = path.join(dir, 'export.png');
    await run(ffmpeg, ['-v', 'error', '-i', mp4, '-frames:v', '1', frame]);
    const output = await measure(readFileSync(frame));
    compare(after.actor, before.actor, '待机与生成口型预览人物边界');
    compare(output.actor, before.actor, '导出 MP4 与生成前人物边界');
    compare(after.subtitle, before.subtitle, '生成前后字幕边界');
    compare(output.subtitle, before.subtitle, '导出 MP4 与生成前字幕边界');
    const metrics = JSON.stringify({ before, after, output });
    writeFileSync(path.join(dir, 'bounds.json'), metrics);
    test.info().annotations.push({ type: '1080p 边界（左、上、右、下）', description: metrics });
    await page.getByRole('button', { name: '版本', exact: true }).click();
    const retake = page.getByRole('button', { name: '按原素材清晰度重制本页人物' });
    await retake.click();
    await expect(page.getByText(/1 段音频、0 段人物视频/)).toBeVisible();
    await page.getByRole('button', { name: '返回编辑' }).click();
    await expect(retake).toBeVisible();
    expect(store.get(course.id).slides[0].videoTake).toBeUndefined();
  } finally {
    await app?.close();
    store.close();
  }
});
