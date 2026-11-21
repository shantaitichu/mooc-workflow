import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { readPptx, importSlides } from '../desktop/importer';
import { WorkspaceStore } from '../desktop/store';

test('PPT 按演示关系顺序提取页面标题及备注正文', () => {
  const result = readPptx(path.resolve('tests/fixtures/lesson.pptx'));
  assert.equal(result.titles.length, 2);
  assert.match(result.titles[0], /第一章/);
  assert.match(result.notes[0], /这是第一页的讲稿/);
  assert.match(result.notes[1], /这是第二页的讲稿/);
});
test('PDF 实际渲染为可用页面图片', { timeout: 60000 }, async () => {
  mkdirSync('.data', { recursive: true });
  const root = mkdtempSync(path.resolve('.data/pdf-'));
  const store = new WorkspaceStore(root);
  try {
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      '<< /Length 55 >>\nstream\nBT /F1 36 Tf 80 300 Td (MOOC import test) Tj ET\nendstream',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    for (const [i, o] of objects.entries()) {
      offsets.push(Buffer.byteLength(pdf));
      pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
    }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
      .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const file = path.join(root, 'fixture.pdf');
    writeFileSync(file, pdf);
    const course = store.create('PDF 验收');
    const result = await importSlides(store, course.id, [file]);
    assert.equal(result.course.slides.length, 1);
    const raster = readFileSync(store.assetPath(course.id, result.course.slides[0].assetId!));
    assert.equal(raster.readUInt32BE(16), 3840);
    assert.equal(raster.readUInt32BE(20), 2160);
  } finally {
    store.close();
  }
});
test(
  '本机 PowerPoint/LibreOffice 按原比例渲染 4:3 PPTX 并绑定备注',
  { skip: process.platform !== 'win32', timeout: 180000 },
  async () => {
    mkdirSync('.data', { recursive: true });
    const root = mkdtempSync(path.resolve('.data/ppt-'));
    const store = new WorkspaceStore(root);
    try {
      const course = store.create('PPT 导入验收');
      const archive = unzipSync(readFileSync('tests/fixtures/lesson.pptx'));
      const part = 'ppt/presentation.xml';
      archive[part] = strToU8(
        strFromU8(archive[part]).replace(/<p:sldSz[^>]*\/>/, '<p:sldSz cx="9144000" cy="6858000"/>'),
      );
      const file = path.join(root, '4x3.pptx');
      writeFileSync(file, zipSync(archive));
      const result = await importSlides(store, course.id, [file]);
      assert.equal(result.course.slides.length, 2);
      assert.match(result.course.slides[0].spokenText, /第一页/);
      for (const slide of result.course.slides) {
        const png = readFileSync(store.assetPath(course.id, slide.assetId!));
        assert.ok(Math.abs(png.readUInt32BE(16) / png.readUInt32BE(20) - 4 / 3) < 0.002);
      }
    } finally {
      store.close();
    }
  },
);
