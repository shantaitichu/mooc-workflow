import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { run } from '../desktop/process';
import { WorkspaceStore } from '../desktop/store';
import { MediaEngine, probe } from '../desktop/media';
import { ffmpeg, ffprobe } from './media-tools';
test(
  '100 页、60 分钟的真实合成时序压力测试',
  { skip: process.env.MOOC_LONG_TEST !== '1', timeout: 900000 },
  async () => {
    const root = path.resolve('.data/long-course');
    mkdirSync(root, { recursive: true });
    const store = new WorkspaceStore(path.join(root, 'workspace'));
    store.saveSettings({ ...store.settings(), ffmpegPath: ffmpeg, ffprobePath: ffprobe });
    const media = new MediaEngine(store);
    try {
      const files: string[] = [];
      for (let i = 0; i < 100; i++) {
        const cached = path.join(root, `page-${i}.mp4`);
        if (process.env.MOOC_REUSE_LONG_FIXTURES === '1' && existsSync(cached)) {
          files.push(cached);
          continue;
        }
        const canvas = createCanvas(1920, 1080);
        const c = canvas.getContext('2d');
        c.fillStyle = `rgb(${i + 30},65,80)`;
        c.fillRect(0, 0, 1920, 1080);
        c.fillStyle = '#fff';
        c.font = '80px sans-serif';
        c.fillText(`PAGE ${i + 1} / 100`, 150, 400);
        c.font = '32px sans-serif';
        c.fillText('Synthetic timing fixture - not a digital human quality sample', 150, 520);
        const png = path.join(root, `page-${i}.png`);
        writeFileSync(png, canvas.toBuffer('image/png'));
        const output = path.join(root, `page-${i}.mp4`);
        await run(
          ffmpeg,
          [
            '-y',
            '-v',
            'error',
            '-loop',
            '1',
            '-framerate',
            '25',
            '-i',
            png,
            '-f',
            'lavfi',
            '-i',
            'anullsrc=r=48000:cl=stereo',
            '-t',
            '36',
            '-vf',
            'format=yuv420p',
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-tune',
            'stillimage',
            '-crf',
            '28',
            '-r',
            '25',
            '-c:a',
            'aac',
            '-b:a',
            '64k',
            output,
          ],
          { timeoutMs: 120000 },
        );
        files.push(output);
        if ((i + 1) % 20 === 0) process.stdout.write(`已生成 ${i + 1}/100 页时序测试片段\n`);
      }
      const output = path.join(root, 'course-60min.mp4');
      await media.concatVideo(files, output);
      const info = await probe(output, ffprobe);
      assert.equal(info.width, 1920);
      assert.equal(info.height, 1080);
      assert.equal(info.fps, 25);
      assert.ok(Math.abs(info.durationMs! - 3600000) <= 40, `总时长 ${info.durationMs}`);
      // Packet count verifies the 60-minute frame budget, independently of container duration.
      const details = JSON.parse(
        await run(
          ffprobe,
          [
            '-v',
            'error',
            '-select_streams',
            'v:0',
            '-count_packets',
            '-show_entries',
            'stream=nb_read_packets,duration',
            '-of',
            'json',
            output,
          ],
          { timeoutMs: 120000 },
        ),
      );
      assert.equal(Number(details.streams[0].nb_read_packets), 90000);
      writeFileSync(
        path.join(root, 'report.json'),
        JSON.stringify(
          {
            pages: 100,
            expectedDurationMs: 3600000,
            measured: info,
            videoPackets: 90000,
            scope: 'synthetic compositor timing only; no model quality assessment',
          },
          null,
          2,
        ),
      );
    } finally {
      store.close();
    }
  },
);
