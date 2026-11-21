import { createCanvas } from '@napi-rs/canvas';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchDesktop } from './launch-desktop';

async function bounds(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('找不到预览中的图层');
  return box;
}

async function drag(page: Page, x: number, y: number, dx: number, dy: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 3 });
  await page.mouse.up();
}

test('预览中移动满幅课件、按比例缩放并逐页保存画布底色', async () => {
  test.setTimeout(90_000);
  mkdirSync('.data', { recursive: true });
  const data = mkdtempSync(path.resolve('.data/ui-canvas-'));
  const sources = ['#617591', '#bdc9a8'].map((color, index) => {
    const canvas = createCanvas(index === 0 ? 320 : 240, 180);
    const context = canvas.getContext('2d');
    context.fillStyle = color;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const file = path.join(data, '课件' + (index + 1) + '.png');
    writeFileSync(file, canvas.toBuffer('image/png'));
    return file;
  });
  const app = await launchDesktop(data);
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false),
    );
    await expect(page.getByText('开始制作你的第一门课程')).toBeVisible();
    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
    }, sources);
    await page.evaluate(async () => {
      const course = await window.mooc!.createCourse('课件画布验收');
      await window.mooc!.importSlides(course.id);
    });
    const layout = page.getByRole('button', { name: '画面设置', exact: true });
    await layout.click();
    await page.getByRole('button', { name: '课件＋人物小窗', exact: true }).click();
    const picker = page.getByLabel('画布底色', { exact: true });
    const stage = page.locator('.layout-stage');
    const deck = stage.locator('.deck-hit');
    const image = stage.locator('foreignObject').filter({ has: page.locator('.stage-deck-image') });
    const background = stage.locator('.canvas-background');
    await expect(picker).toHaveAttribute('type', 'color');
    await expect(picker).toHaveValue('#ffffff');
    await expect(background).toHaveCSS('fill', 'rgb(255, 255, 255)');
    await picker.fill('#bacded');
    await expect(background).toHaveCSS('fill', 'rgb(186, 205, 237)');
    await stage.scrollIntoViewIfNeeded();
    const frame = await bounds(stage);
    const full = await bounds(image);
    expect(full.width).toBeCloseTo(frame.width, 0);
    const hit = await bounds(deck);
    await drag(page, hit.x + hit.width / 3, hit.y + hit.height / 2, -frame.width * 0.2, -frame.height * 0.16);
    const moved = await bounds(image);
    expect(moved.x).toBeCloseTo(full.x - frame.width * 0.2, -1);
    expect(moved.y).toBeCloseTo(full.y - frame.height * 0.16, -1);
    expect(moved.width).toBeCloseTo(full.width, 0);

    const corner = await bounds(stage.locator('.deck-handle[data-corner="se"]'));
    await drag(
      page,
      corner.x + corner.width / 2,
      corner.y + corner.height / 2,
      -frame.width * 0.33,
      -frame.height * 0.33,
    );
    const smaller = await bounds(image);
    expect(smaller.width / full.width).toBeCloseTo(0.67, 1);
    expect(smaller.width / smaller.height).toBeCloseTo(16 / 9, 2);
    expect(smaller.x).toBeCloseTo(moved.x, 0);
    expect(smaller.y).toBeCloseTo(moved.y, 0);
    await drag(
      page,
      smaller.x + smaller.width / 2,
      smaller.y + smaller.height / 2,
      frame.width * 0.23,
      frame.height * 0.3,
    );
    const placed = await bounds(image);
    const lecturer = await bounds(stage.locator('.person-hit'));
    expect(placed.x).toBeGreaterThan(frame.x);
    expect(placed.x + placed.width).toBeLessThan(lecturer.x);

    await page.getByRole('button', { name: '从预览取色', exact: true }).click();
    await stage.scrollIntoViewIfNeeded();
    const sample = await bounds(image);
    await page.mouse.click(sample.x + sample.width / 3, sample.y + sample.height / 2);
    await expect(picker).toHaveValue('#617591');
    await expect(background).toHaveCSS('fill', 'rgb(97, 117, 145)');

    const savedBounds = await image.evaluate((element: SVGForeignObjectElement) => {
      const { x, y, width, height } = element.getBBox();
      return { x, y, width, height };
    });
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await window.mooc!.state()).courses[0].slides[0].compositionOverride?.backgroundColor,
        ),
      )
      .toBe('#617591');
    await page.locator('.slide-card').nth(1).click();
    await expect(picker).toHaveValue('#ffffff');
    await page.reload();
    await layout.click();
    await expect(picker).toHaveValue('#617591');
    await expect(background).toHaveCSS('fill', 'rgb(97, 117, 145)');
    expect(
      await image.evaluate((element: SVGForeignObjectElement) => {
        const { x, y, width, height } = element.getBBox();
        return { x, y, width, height };
      }),
    ).toEqual(savedBounds);

    await page.locator('.slide-card').nth(1).click();
    await stage.scrollIntoViewIfNeeded();
    await expect
      .poll(async () => {
        const box = await bounds(deck);
        return box.width / box.height;
      })
      .toBeCloseTo(4 / 3, 2);
    const firstFourThirds = await bounds(deck);
    await deck.click();
    const nw = await bounds(stage.locator('.deck-handle[data-corner="nw"]'));
    await drag(
      page,
      nw.x + nw.width / 2,
      nw.y + nw.height / 2,
      firstFourThirds.width * 0.2,
      firstFourThirds.height * 0.2,
    );
    const resized = await bounds(deck);
    expect(resized.width / resized.height).toBeCloseTo(4 / 3, 2);
    expect(resized.width / firstFourThirds.width).toBeCloseTo(0.8, 1);
    expect(Math.abs(resized.x + resized.width - firstFourThirds.x - firstFourThirds.width)).toBeLessThan(1);
    expect(Math.abs(resized.y + resized.height - firstFourThirds.y - firstFourThirds.height)).toBeLessThan(1);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByText('已保存到本地', { exact: true })).toBeVisible();
  } catch (error) {
    await app
      .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((win) => win.destroy()))
      .catch(() => {});
    throw error;
  } finally {
    await app.close();
  }
});
