import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { MediaEngine } from '../desktop/media';
import { WorkspaceStore } from '../desktop/store';
import { captionPng } from '../desktop/caption-raster';
import { run } from '../desktop/process';
import { newSlide } from '../shared/domain';
import { captionAt, captionStrip, pageCaptionCues } from '../shared/subtitles';
import { editTimeline } from '../shared/edit-timeline';
import { ffmpeg, ffprobe } from './media-tools';

test('编辑和编码共用字幕像素、逐帧气口与单独撰写的字幕', { skip: !existsSync(ffmpeg) }, async () => {
  const dir = mkdtempSync(path.resolve('.data-test-'));
  const store = new WorkspaceStore(dir);
  try {
    store.saveSettings({ ...store.settings(), ffmpegPath: ffmpeg, ffprobePath: ffprobe });
    const media = new MediaEngine(store);
    const course = store.create('字幕一致性');
    const slide = newSlide('');
    course.composition.layout = 'slides';
    course.composition.backgroundColor = '#000000';
    course.composition.subtitleSize = 53;
    course.composition.subtitleBottom = 19;
    course.slides.push(slide);
    slide.subtitleText = '单独撰写的字幕';
    slide.segments = [{ id: 'sentence', text: '实际读音', caption: '初稿' }];
    const timeline = editTimeline(course)[0];
    assert.deepEqual(
      timeline.captions,
      pageCaptionCues(slide.subtitleText, [{ text: '初稿', durationMs: timeline.voiceEnd }]),
    );
    assert.equal(timeline.captions[0].text, slide.subtitleText);
    const cues = [
      { startMs: 65, endMs: 165, text: '首先来看时间上的累积。' },
      { startMs: 259, endMs: 361, text: 'F = ma' },
    ];
    const audio = path.join(dir, 'sound.wav');
    await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '0.52', audio]);
    const video = path.join(dir, 'page.mp4');
    await media.compose(course, slide, audio, undefined, cues, video);
    const size = course.composition.subtitleSize;
    const strip = captionStrip(size, Math.round((1080 * course.composition.subtitleBottom) / 100));
    await run(ffmpeg, [
      '-v',
      'error',
      '-i',
      video,
      '-vf',
      'crop=' + [strip.width, strip.height, 0, strip.y].join(':'),
      path.join(dir, 'frame-%02d.png'),
    ]);
    // Compare the 50% white glyph contours after actual H.264 compression. The raster includes an outline.
    async function bounds(png: string | Buffer) {
      const ctx = createCanvas(strip.width, strip.height).getContext('2d');
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, strip.width, strip.height);
      ctx.drawImage(await loadImage(png), 0, 0);
      const { data } = ctx.getImageData(0, 0, strip.width, strip.height);
      let left = strip.width,
        top = strip.height,
        right = -1,
        bottom = -1;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] < 128) continue;
        const x = (i / 4) % strip.width;
        const y = Math.floor(i / 4 / strip.width);
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
      return right < 0 ? [] : [left, top, right, bottom];
    }
    const expected = new Map([['', [] as number[]]]);
    for (const cue of cues) {
      const box = await bounds(captionPng(cue.text, size));
      assert.equal(box.length, 4);
      expected.set(cue.text, box);
    }
    for (let frame = 0; frame < 13; frame++) {
      const text = captionAt(cues, frame * 40);
      const preview = expected.get(text)!;
      const rendered = await bounds(path.join(dir, 'frame-' + String(frame + 1).padStart(2, '0') + '.png'));
      assert.equal(rendered.length, preview.length, 'frame ' + frame);
      preview.forEach((value, i) =>
        assert.ok(
          Math.abs(value - rendered[i]) <= 1,
          'frame ' + frame + ' preview ' + preview + ' encoded ' + rendered,
        ),
      );
    }
  } finally {
    store.close();
  }
});
