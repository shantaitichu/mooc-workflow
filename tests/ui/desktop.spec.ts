import { createCanvas } from '@napi-rs/canvas';
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { Database } from '../../server/database';
import { bootstrap } from '../../server/auth';
import { ObjectStore } from '../../server/objects';
import { Billing } from '../../server/billing';
import { Worker } from '../../server/worker';
import { createApp } from '../../server/app';
import { ffmpeg as videoEncoder, ffprobe } from '../media-tools';
import { matteModel } from '../../shared/domain';
import { launchDesktop } from './launch-desktop';

async function capture(application: Awaited<ReturnType<typeof electron.launch>>, target: string) {
  // Native capture explicitly keeps hidden packaged windows awake; CDP screenshot can stall without it.
  const png = await application.evaluate(async ({ BrowserWindow }) => {
    const frame = await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, {
      stayHidden: true,
      stayAwake: true,
    });
    return frame.toPNG().toString('base64');
  });
  expect(png.length).toBeGreaterThan(1000);
  writeFileSync(target, Buffer.from(png, 'base64'));
}

test('桌面端编辑、保存、重排、讲师档案和真实 IPC', async () => {
  test.setTimeout(180000);
  const data = path.resolve('.data/ui-test-' + Date.now());
  mkdirSync(data, { recursive: true });
  const db = new Database(':memory:');
  await db.initialize();
  await bootstrap(db, 'author@example.test', 'test-password-1234');
  const objects = new ObjectStore(db, path.join(data, 'objects'), 'http://127.0.0.1', 'x'.repeat(32), {});
  const server = createApp(db, objects, {
    ENABLED_VERIFIED_MODELS: 'dreamactor-2.0,' + matteModel,
    PUBLIC_BASE_URL: 'https://storage.example.test',
    VOLC_MEDIAKIT_API_KEY: 'test',
    VISUAL_PROVIDER: 'gateway',
    VISUAL_GATEWAY_URL: 'https://gateway.example.test',
    VISUAL_GATEWAY_TOKEN: 'test',
    FFPROBE_PATH: ffprobe,
  });
  const calls: string[] = [];
  const worker = new Worker(db, new Billing(db), objects, {
    async submit(input, userId) {
      calls.push(input.kind);
      if (input.kind === 'motion') {
        await objects.owned(userId, input.imageAssetId!);
        await objects.owned(userId, input.videoAssetId!);
        return { bytes: await objects.read(input.videoAssetId!), mime: 'video/mp4' };
      }
      if (input.kind !== 'matte') throw new Error('测试仅提供动作和抠像响应');
      const file = path.join(data, 'returned.webm');
      execFileSync(
        videoEncoder,
        [
          '-y',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=s=80x80:d=' + input.durationMs! / 1000 + ',format=rgba,pad=320:200:120:60:color=black@0',
          '-c:v',
          'libvpx-vp9',
          '-pix_fmt',
          'yuva420p',
          file,
        ],
        { windowsHide: true },
      );
      return { bytes: readFileSync(file), mime: 'video/webm' };
    },
    async poll() {
      throw new Error('测试结果同步返回');
    },
  });
  const address = await server.listen({ port: 0, host: '127.0.0.1' });
  worker.start();
  const application = await launchDesktop(data);
  try {
    const page = await application.firstWindow();
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false),
    );
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await expect(page.getByText('开始制作你的第一门课程')).toBeVisible();
    await page.getByRole('button', { name: '新建课程', exact: true }).last().click();
    await page.getByPlaceholder('例如：数字素养与人工智能基础').fill('数字素养与人工智能基础');
    await page.getByRole('button', { name: '创建课程', exact: true }).click();
    await expect(page.getByRole('heading', { name: '数字素养与人工智能基础', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '添加空白页', exact: true }).last().click();
    await page
      .getByRole('textbox', { name: '本页讲稿', exact: true })
      .fill('欢迎来到数字素养课程。我们将一起认识人工智能。');
    await page.getByRole('button', { name: '插入气口', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '本页讲稿', exact: true })).toContainText('[停顿500ms]');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByText('已保存到本地', { exact: true })).toBeVisible();
    const saved = await page.evaluate(async () => window.mooc!.state());
    expect(saved.courses[0].slides[0].spokenText).toContain('[停顿500ms]');
    expect(saved.capabilities.ffmpeg).toBe(true);
    await page.getByRole('button', { name: '画面设置', exact: true }).click();
    const person = await page.locator('.person-hit').boundingBox();
    const stage = await page.locator('.layout-stage').boundingBox();
    if (!person || !stage) throw new Error('缺少编辑画布');
    await page.mouse.move(person.x + person.width / 2, person.y + person.height / 2);
    await page.mouse.down();
    await page.mouse.move(stage.x - 10, person.y + person.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await window.mooc!.state()).courses[0].slides[0].compositionOverride?.presenterX,
        ),
      )
      .toBeLessThan(0);
    await page.getByRole('button', { name: '将讲师移回画布中央' }).click();
    await page.getByRole('button', { name: '纯课件配音', exact: true }).click();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByLabel('版式名称').fill('实验课堂');
    await page.getByRole('button', { name: '另存为新版式' }).click();
    await expect
      .poll(
        async () =>
          await page.evaluate(async () =>
            (await window.mooc!.state()).courses[0].layoutPresets?.some((p) => p.name === '实验课堂'),
          ),
      )
      .toBe(true);
    await page.getByRole('button', { name: '添加空白页', exact: true }).last().click();
    await page.getByRole('checkbox', { name: '选择第 1 页', exact: true }).check();
    await page.evaluate(() => {
      window.confirm = () => true;
    });
    await page.getByRole('button', { name: '只保留所选' }).click();
    await expect(page.locator('.slide-card')).toHaveCount(1);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.reload();
    await expect(page.getByRole('heading', { name: '数字素养与人工智能基础', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '讲师档案', exact: true }).click();
    await page.getByLabel('讲师名称').fill('李老师');
    await page.getByRole('button', { name: '保存更改', exact: true }).click();
    const canvas = createCanvas(60, 80),
      ctx = canvas.getContext('2d');
    ctx.fillStyle = '#dddddd';
    ctx.fillRect(0, 0, 60, 80);
    ctx.fillStyle = '#633929';
    ctx.fillRect(20, 10, 20, 70);
    const portrait = path.join(data, 'portrait.png'),
      refAudio = path.join(data, 'voice.wav'),
      refVideo = path.join(data, 'movement.mov');
    writeFileSync(portrait, canvas.toBuffer('image/png'));
    const ffmpeg = path.resolve('resources/bin/ffmpeg.exe');
    execFileSync(ffmpeg, [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=80x80:d=3.2,format=rgba,pad=320:200:120:60:color=black@0',
      '-c:v',
      'qtrle',
      '-pix_fmt',
      'argb',
      refVideo,
    ]);
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=0.8', refAudio]);
    await page.evaluate(() => {
      window.confirm = () => true;
    });
    await application.evaluate(({ shell }) => {
      shell.showItemInFolder = file => { process.env.MOOC_TEST_REVEALED = file; };
    });
    const lastRevealed = () => application.evaluate(() => process.env.MOOC_TEST_REVEALED ?? '');
    const opaque = path.join(data, 'original.mp4');
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=160x120:d=1', '-c:v', 'libx264', opaque]);
    await application.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, opaque);
    for (const name of ['人物动作视频', '动态待机视频']) {
      const tile = page.locator('.media-tile').filter({ has: page.getByRole('heading', { name, exact: true }) });
      await page.evaluate(() => { window.confirm = () => { throw new Error('视频导入不应请求云端处理'); }; });
      await tile.getByRole('button', { name: '导入' + name, exact: true }).click();
      const remove = tile.getByRole('button', { name: '移除视频背景', exact: true });
      await expect(remove).toBeEnabled();
      const preview = await tile.locator('video').getAttribute('src');
      await page.evaluate(() => { window.confirm = () => false; });
      await remove.click();
      await expect(tile.locator('video')).toHaveAttribute('src', preview!);
      await expect(remove).toBeEnabled();
    }
    expect(calls).toEqual([]);
    await page.evaluate(() => { window.confirm = () => true; });
    for (const [name, file, selector] of [
      ['人物照片', portrait, 'img'],
      ['人物动作视频', refVideo, 'video'],
      ['动态待机视频', refVideo, 'video'],
      ['音色参考', refAudio, 'audio'],
    ]) {
      await application.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      }, file);
      await page.getByRole('button', { name: (selector === 'video' ? '更换' : '导入') + name, exact: true }).click();
      await expect(
        page
          .locator('.media-tile')
          .filter({ has: page.getByRole('heading', { name, exact: true }) })
          .locator('.media-source ' + selector),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: '更换' + name, exact: true })).toBeEnabled();
      const tile = page.locator('.media-tile').filter({ has: page.getByRole('heading', {name, exact:true}) });
      if (selector === 'video') {
        await expect(tile.getByText('已识别透明背景，可直接使用。')).toBeVisible();
        await expect(tile.getByRole('button', { name: '移除视频背景' })).toHaveCount(0);
      }
      const src = await tile.locator('.media-source ' + selector).getAttribute('src');
      const asset = src!.split('/').pop()!;
      await tile.getByRole('button', { name: '打开保存位置', exact: true }).click();
      await expect.poll(async () => path.parse(await lastRevealed()).name).toBe(asset);
      expect(existsSync(await lastRevealed())).toBe(true);
    }
    await expect(page.getByLabel('可用音色')).toBeVisible();
    await capture(application, path.join(data, 'lecturer.png'));
    await page.getByRole('button', { name: '课程制作', exact: true }).click();
    await page.getByRole('button', { name: '动作素材', exact: true }).click();
    const startLine = page.locator('.cut-line.start');
    await startLine.evaluate(el => el.scrollIntoView({block:'center'}));
    const line = await startLine.boundingBox();
    if (!line) throw new Error('剪辑轨缺少入点');
    await page.mouse.move(line.x + line.width * .75, line.y + line.height / 2);
    await page.mouse.down();
    await page.mouse.move(line.x + 34, line.y + line.height / 2, {steps:6});
    await page.mouse.up();
    await expect.poll(async()=>Number(await page.getByLabel('入点（秒）').inputValue())).toBeGreaterThan(0);
    await page.getByLabel('入点（秒）').fill('1.12');
    await page.getByLabel('出点（秒）').fill('1.64');
    const trim = page.locator('.trim-player');
    await trim.evaluate((v: HTMLVideoElement) => {
      v.currentTime = 0.04;
      const starts: number[] = [];
      v.dataset.starts = '[]';
      v.addEventListener('playing', () => {
        starts.push(v.currentTime);
        v.dataset.starts = JSON.stringify(starts);
      });
    });
    await page.getByRole('button', { name: '循环预览选段' }).click();
    await expect
      .poll(() => trim.evaluate((v: HTMLVideoElement) => JSON.parse(v.dataset.starts!).length))
      .toBeGreaterThanOrEqual(2);
    expect(
      await trim.evaluate((v: HTMLVideoElement) =>
        (JSON.parse(v.dataset.starts!) as number[]).every((t) => t >= 1.1 && t < 1.29),
      ),
    ).toBe(true);
    await page.getByRole('button', { name: '停止选段预览' }).click();
    await page.getByLabel('选段名称').fill('手势试剪');
    await page.getByRole('button', { name: '保存选段' }).click();
    const shelf = page.getByRole('region', { name: '已保存选段' });
    const first = shelf.getByRole('article', { name: '手势试剪', exact: true });
    await expect(first).toBeVisible();
    await page.getByLabel('入点（秒）').fill('0.24');
    await page.getByLabel('出点（秒）').fill('0.84');
    await page.getByLabel('选段名称').fill('点头备选');
    await page.getByRole('button', { name: '保存选段' }).click();
    await expect(shelf.getByRole('article')).toHaveCount(2);
    await page.getByRole('button', { name: '保存选段' }).click();
    await expect(page.getByRole('status').filter({ hasText: '此时间范围已保存' })).toBeVisible();
    expect(calls).toEqual([]);
    await page.reload();
    await page.getByRole('button', { name: '动作素材', exact: true }).click();
    await expect(shelf.getByRole('article')).toHaveCount(2);
    await first.getByRole('button', { name: '预览选段' }).click();
    await expect(first.getByRole('button', { name: '重播选段' })).toBeVisible();
    const previewTime = await first.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime);
    expect(previewTime).toBeGreaterThanOrEqual(1.12);
    expect(previewTime).toBeLessThan(1.65);
    await expect(first.getByRole('button', { name: /生成动作素材/ })).toBeDisabled();
    await first.getByRole('button', { name: '打开保存位置', exact: true }).click();
    await expect.poll(lastRevealed).toContain('选段-手势试剪-');
    const cutFile = await lastRevealed();
    const cutDuration = execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', cutFile], { encoding: 'utf8', windowsHide: true });
    expect(Number(cutDuration)).toBeCloseTo(0.52, 2);
    await page.evaluate(async (address) => {
      const api = window.mooc!;
      await api.saveSettings({ ...(await api.state()).settings, cloudUrl: address });
      const user = await api.login('author@example.test', 'test-password-1234');
      await api.grant(user.email, 10000000, crypto.randomUUID());
    }, address);
    await page.getByRole('button', { name: '课程制作', exact: true }).click();
    await page.getByRole('button', { name: '动作素材', exact: true }).click();
    await page.evaluate(() => { window.confirm = () => true; });
    await first.getByRole('button', { name: /生成动作素材/ }).click();
    await expect
      .poll(
        async () =>
          page.evaluate(async () =>
            (await window.mooc!.state()).courses[0].speaker.motions.map((m) => m.name),
          ),
        { timeout: 60000 },
      )
      .toEqual(['手势试剪']);
    expect(calls).toEqual(['motion', 'matte']);
    await expect(first.getByText('已生成', { exact: true })).toBeVisible();
    await expect(shelf.getByRole('article')).toHaveCount(2);
    await first.getByRole('button', { name: '删除选段「手势试剪」' }).click();
    await expect(shelf.getByRole('article')).toHaveCount(1);
    await capture(application, path.join(data, 'motion-studio.png'));
    await page.getByRole('button', { name: '课程制作', exact: true }).click();
    await page.getByRole('button', { name: '画面设置', exact: true }).click();
    await page.getByRole('button', { name: '左右分栏', exact: true }).click();
    const marker = page
        .getByRole('region', { name: '课程可用动作' })
        .getByRole('button', { name: '手势试剪', exact: true }),
      rail = page.locator('.motion-rail');
    await marker.dragTo(rail, { targetPosition: { x: 50, y: 10 } });
    await expect(page.locator('.motion-event')).toHaveCount(1);
    await page.getByLabel('动作起点（秒）').fill('0.48');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await window.mooc!.state()).courses[0].slides[0].motionTrack?.[0]?.startMs,
        ),
      )
      .toBe(480);
    const voices = page.locator('.voice-lane button');
    const original = await voices.allTextContents();
    expect(original.length).toBeGreaterThan(1);
    await voices.last().dragTo(voices.first(), { targetPosition: { x: 1, y: 6 } });
    await expect(voices.first()).toHaveText(original.at(-1)!);
    await capture(application, '.data/desktop-workspace.png');
    await page.getByRole('button', { name: '动作素材', exact: true }).click();
    await page.evaluate(() => {
      window.confirm = () => true;
    });
    await page.getByRole('button', { name: '删除动作', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const c = (await window.mooc!.state()).courses[0];
          return [c.speaker.motions.length, c.slides[0].motionTrack?.length];
        }),
      )
      .toEqual([0, 0]);
    expect(errors).toEqual([]);
  } catch (error) {
    await application
      .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()))
      .catch(() => {});
    throw error;
  } finally {
    await application.close();
    worker.stop();
    await server.close();
    await db.close();
  }
});

test('真实桌面制作闭环：课件与录音导入、生成、审核、导出', async () => {
  test.setTimeout(180000);
  const root = path.resolve('.data/ui-production-' + Date.now());
  mkdirSync(root, { recursive: true });
  const audio = path.join(root, 'recording.wav');
  execFileSync(
    path.resolve('node_modules/ffmpeg-static/ffmpeg.exe'),
    ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=48000:duration=1.5', audio],
    { windowsHide: true },
  );
  const application = await launchDesktop(root);
  try {
    const page = await application.firstWindow();
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false),
    );
    await expect(page.getByText('开始制作你的第一门课程')).toBeVisible();
    await application.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, path.resolve('tests/fixtures/lesson.pptx'));
    const courseId = await page.evaluate(async () => {
      const c = await window.mooc!.createCourse('真实本地闭环验收');
      await window.mooc!.importSlides(c.id);
      return c.id;
    });
    await application.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, audio);
    await page.evaluate(async (id) => {
      const result = await window.mooc!.importAsset(id, 'audio');
      const c = result!.course;
      c.composition.layout = 'slides';
      for (const slide of c.slides) {
        slide.recordedAudioId = result!.asset.id;
        slide.subtitleText = '合成时序测试音（非真实讲师语音）';
      }
      await window.mooc!.saveCourse(c);
    }, courseId);
    const master = page.locator('.video-lane button');
    await expect(master).toHaveCount(2);
    const first = await master.first().textContent();
    await page.getByRole('button', { name: '播放预览', exact: true }).click();
    await expect
      .poll(() => page.locator('.video-lane button.active').textContent(), { timeout: 10000 })
      .not.toBe(first);
    await page.getByRole('button', { name: '回到起点' }).click();
    await expect(page.locator('.video-lane button.active')).toHaveText(first!);
    const pageBefore = await page.getByLabel('页面标题').inputValue();
    // Keep the track clear of the fixed application status bar on short screens.
    await master.first().evaluate((b) => b.scrollIntoView({ block: 'center', inline: 'nearest' }));
    await master.last().dragTo(master.first(), { targetPosition: { x: 20, y: 12 } });
    await expect(master.last()).toHaveAttribute('title', '拖动调整页序 · ' + pageBefore);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect
      .poll(() => page.evaluate(async () => (await window.mooc!.state()).courses[0].slides[1].title))
      .toBe(pageBefore);
    await page.getByRole('button', { name: '生成本页样片', exact: true }).click();
    await expect(page.getByText('本次使用本地录音或已有素材，无需上传或调用模型。')).toBeVisible();
    await expect(page.getByRole('button', { name: '确认预算并生成', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '返回编辑', exact: true }).click();
    await page.evaluate(async (id) => {
      const c = (await window.mooc!.state()).courses.find((c) => c.id === id)!;
      await window.mooc!.produce({
        courseId: id,
        slideIds: c.slides.map((s) => s.id),
        budgetMicros: 0,
        sample: true,
      });
    }, courseId);
    await expect
      .poll(async () => (await page.evaluate(() => window.mooc!.state())).tasks[0]?.status, {
        timeout: 90000,
      })
      .toBe('completed');
    const task = (await page.evaluate(() => window.mooc!.state())).tasks[0];
    expect(task.message).not.toContain('失败');
    await page.evaluate(async (id) => {
      const state = await window.mooc!.state();
      const c = state.courses.find((c) => c.id === id)!;
      for (const slide of c.slides) {
        const artifact = c.artifacts.find((a) => a.slideId === slide.id && a.stage === 'composition')!;
        slide.reviewedFingerprint = artifact.fingerprint;
        slide.approvedSampleFingerprint = artifact.fingerprint;
      }
      await window.mooc!.saveCourse(c);
    }, courseId);
    await expect(page.locator('.preview-stage video')).toHaveCount(1);
    await expect
      .poll(() => page.locator('.preview-stage video').evaluate((v: HTMLVideoElement) => v.readyState))
      .toBeGreaterThanOrEqual(2);
    await page.getByRole('button', { name: '播放预览', exact: true }).click();
    await expect
      .poll(() => page.locator('.preview-stage video').evaluate((v: HTMLVideoElement) => v.currentTime))
      .toBeGreaterThan(0.2);
    await page.getByRole('button', { name: '播放预览', exact: true }).click();
    await expect
      .poll(() => page.locator('.preview-stage video').evaluate((v: HTMLVideoElement) => v.paused))
      .toBe(true);
    await capture(application, '.data/desktop-production.png');
    const exportRoot = path.join(root, 'exports');
    mkdirSync(exportRoot, { recursive: true });
    await application.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, exportRoot);
    const output = await page.evaluate(
      (id) => window.mooc!.exportCourse(id, { subtitles: true, perSlide: true, audio: true, project: true }),
      courseId,
    );
    expect(existsSync(output!)).toBe(true);
    await page.getByRole('button', { name: '制作任务', exact: true }).click();
    const history = page.locator('.production-history');
    await history.getByLabel('查看范围').selectOption(task.id);
    await expect(history.locator('.batch-page')).toHaveCount(2);
    await expect(history.locator('.batch-stages').getByText('已有成片', { exact: true })).toHaveCount(2);
    await history.getByRole('button', { name: '查看素材' }).first().click();
    await expect(history.locator('.batch-media audio').first()).toBeVisible();
    const replacement = path.join(root, 'replacement.wav');
    execFileSync(path.resolve('node_modules/ffmpeg-static/ffmpeg.exe'),
      ['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1',replacement], { windowsHide: true });
    await application.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, replacement);
    await history.getByRole('button', { name: '替换配音文件' }).first().click();
    await history.getByRole('button', { name: '确认预算并提交' }).click();
    await expect(history.getByText('成片待更新', { exact: true })).toHaveCount(1);
    await history.getByRole('button', { name: '重试 / 继续本页' }).click();
    await history.getByRole('button', { name: '确认预算并提交' }).click();
    await expect(history.locator('.batch-stages').getByText('已有成片', { exact: true })).toHaveCount(2, { timeout: 30000 });
    const final = await page.evaluate(async () => (await window.mooc!.state()).courses[0]);
    expect(final.batches).toHaveLength(1);
    expect(final.slides[0].recordedAudioId).not.toBe(final.slides[1].recordedAudioId);

  } catch (error) {
    // An unsaved change prompts on close. Always release this isolated window after a failed assertion.
    await application
      .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()))
      .catch(() => {});
    throw error;
  } finally {
    await application.close();
  }
});
