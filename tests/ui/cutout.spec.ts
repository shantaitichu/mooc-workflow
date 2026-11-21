import { test, expect } from '@playwright/test';
import { createCanvas } from '@napi-rs/canvas';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Database } from '../../server/database';
import { bootstrap } from '../../server/auth';
import { ObjectStore } from '../../server/objects';
import { Billing } from '../../server/billing';
import { Worker } from '../../server/worker';
import { createApp } from '../../server/app';
import { portraitModel, portraitPriceMicros } from '../../shared/domain';
import { launchDesktop } from './launch-desktop';

test('讲师导入经后台任务和额度结算保存透明 PNG 及原照', async () => {
  mkdirSync('.data', { recursive: true });
  const root = mkdtempSync(path.resolve('.data/ui-cutout-')),
    db = new Database(':memory:');
  await db.initialize();
  await bootstrap(db, 'author@example.test', 'test-password-1234');
  const objects = new ObjectStore(db, path.join(root, 'objects'), 'http://127.0.0.1', 'x'.repeat(32), {});
  const server = createApp(db, objects, {
    ENABLED_VERIFIED_MODELS: portraitModel,
    VOLC_MEDIAKIT_API_KEY: 'mock',
  });
  const canvas = createCanvas(32, 32),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = 'green';
  ctx.fillRect(0, 0, 32, 32);
  const file = path.join(root, 'source.png');
  writeFileSync(file, canvas.toBuffer('image/png'));
  ctx.clearRect(0, 0, 16, 32);
  const worker = new Worker(db, new Billing(db), objects, {
    submit: async (input, user) => {
      expect(input.model).toBe(portraitModel);
      await objects.owned(user, input.imageAssetId!);
      return { bytes: canvas.toBuffer('image/png'), mime: 'image/png' };
    },
    poll: async () => {
      throw Error('未预期轮询');
    },
  });
  const address = await server.listen({ port: 0, host: '127.0.0.1' });
  worker.start();
  const app = await launchDesktop(path.join(root, 'desktop'));
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(async (address) => {
      const api = window.mooc!,
        s = await api.state();
      await api.saveSettings({ ...s.settings, cloudUrl: address });
      const user = await api.login('author@example.test', 'test-password-1234');
      await api.grant(user.email, 1000000, crypto.randomUUID());
      await api.createCourse('讲师照片');
    }, address);
    await expect(page.getByRole('heading', {name:'讲师照片', exact:true})).toBeVisible();
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, file);
    await page.getByRole('button', { name: '讲师档案', exact: true }).click();
    expect(errors).toEqual([]);
    await page.getByRole('button', { name: '导入人物照片', exact: true }).click();
    await expect(page.getByText('MediaKit 讲师形象.png', { exact: true })).toBeVisible({ timeout: 30000 });
    const result = await page.evaluate(async () => {
      const api = window.mooc!,
        c = (await api.state()).courses[0];
      return {
        image: c.speaker.imageAssetId,
        original: c.speaker.originalPortraitId,
        wallet: (await api.cloudOverview()).wallet,
      };
    });
    expect(result.original).toBeTruthy();
    expect(result.image).not.toBe(result.original);
    expect(result.wallet.spentMicros).toBe(portraitPriceMicros);
  } finally {
    await app.close();
    worker.stop();
    await server.close();
    await db.close();
  }
});
