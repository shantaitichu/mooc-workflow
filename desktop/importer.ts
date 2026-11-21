import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { WorkspaceStore } from './store';
import { newSlide, updateNarration, parsePageScript } from '../shared/domain';
import type { ImportResult, Slide } from '../shared/types';
import { run, findTool } from './process';
import { maxDeckScale } from '../shared/layout';

// Rasterize vector pages at the largest placement allowed in the 1080p editor.
const deckWidth = 1920 * maxDeckScale / 100;
const deckHeight = 1080 * maxDeckScale / 100;

const xml = new XMLParser({ ignoreAttributes: false });
function allText(node: unknown): string[] {
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([key, value]) =>
    key === 'a:t' || key === 'w:t'
      ? [
          typeof value === 'object'
            ? String((value as Record<string, unknown>)['#text'] ?? '')
            : String(value),
        ]
      : Array.isArray(value)
        ? value.flatMap(allText)
        : allText(value),
  );
}
export function readPptx(file: string): { titles: string[]; notes: string[]; warnings: string[] } {
  let bytes = 0;
  const archive = unzipSync(new Uint8Array(readFileSync(file)), {
    filter: (f) => {
      bytes += f.originalSize;
      if (bytes > 512 * 1024 ** 2) throw new Error('课件解压大小超过 512MB');
      return f.name.endsWith('.xml') || f.name.endsWith('.rels');
    },
  });
  const presentation = xml.parse(strFromU8(archive['ppt/presentation.xml']));
  const relationships = xml.parse(strFromU8(archive['ppt/_rels/presentation.xml.rels'])).Relationships
    .Relationship;
  const rels = Array.isArray(relationships) ? relationships : [relationships];
  const ids = presentation['p:presentation']['p:sldIdLst']?.['p:sldId'] ?? [];
  const ordered = (Array.isArray(ids) ? ids : [ids])
    .map(
      (item: Record<string, string>) =>
        rels.find((r: Record<string, string>) => r['@_Id'] === item['@_r:id'])?.['@_Target'],
    )
    .filter(Boolean);
  const titles: string[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];
  for (const target of ordered) {
    const slidePath = path.posix.normalize(`ppt/${target}`);
    const slide = xml.parse(strFromU8(archive[slidePath]));
    titles.push(allText(slide).slice(0, 2).join(' ').slice(0, 100) || `第 ${titles.length + 1} 页`);
    const relPath = path.posix.join(
      path.posix.dirname(slidePath),
      '_rels',
      `${path.posix.basename(slidePath)}.rels`,
    );
    const slideRels = archive[relPath]
      ? xml.parse(strFromU8(archive[relPath])).Relationships.Relationship
      : [];
    const notesRel = (Array.isArray(slideRels) ? slideRels : [slideRels]).find((r: Record<string, string>) =>
      r['@_Type']?.endsWith('/notesSlide'),
    );
    if (!notesRel) {
      notes.push('');
      continue;
    }
    const notesPath = path.posix.normalize(
      path.posix.join(path.posix.dirname(slidePath), notesRel['@_Target']),
    );
    const notesXml = archive[notesPath] ? xml.parse(strFromU8(archive[notesPath])) : {};
    const shapes = notesXml['p:notes']?.['p:cSld']?.['p:spTree']?.['p:sp'] ?? [];
    const bodies = (Array.isArray(shapes) ? shapes : [shapes]).filter(
      (s: any) => s['p:nvSpPr']?.['p:nvPr']?.['p:ph']?.['@_type'] === 'body',
    );
    notes.push(bodies.flatMap(allText).join('\n'));
  }
  if (Object.keys(archive).some((k) => k.includes('externalLink')))
    warnings.push('课件含外部链接，导入不会执行外部内容。');
  return { titles, notes, warnings };
}
async function renderPdf(file: string, destination: string): Promise<string[]> {
  const { createCanvas, DOMMatrix, Path2D, ImageData } = await import('@napi-rs/canvas');
  Object.assign(globalThis, { DOMMatrix, Path2D, ImageData });
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), useSystemFonts: true });
  const doc = await loading.promise;
  if (doc.numPages > 500) throw new Error('单工程最多导入 500 页。');
  const output: string[] = [];
  for (let index = 1; index <= doc.numPages; index++) {
    const page = await doc.getPage(index);
    const base = page.getViewport({ scale: 1 });
    const view = page.getViewport({ scale: Math.min(deckWidth / base.width, deckHeight / base.height) });
    const canvas = createCanvas(Math.ceil(view.width), Math.ceil(view.height));
    await page.render({
      canvasContext: canvas.getContext('2d') as any,
      viewport: view,
      canvas: canvas as any,
    }).promise;
    const outputPath = path.join(destination, `${index}.png`);
    writeFileSync(outputPath, canvas.toBuffer('image/png'));
    output.push(outputPath);
    page.cleanup();
  }
  await loading.destroy();
  return output;
}
async function renderPptx(file: string, directory: string, soffice: string): Promise<string[]> {
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference = 'Stop'
$sourceFile = $args[0]
$exportFolder = $args[1]
$app = $null
$deck = $null
try {
  $app = New-Object -ComObject PowerPoint.Application
  $app.AutomationSecurity = 3
  $deck = $app.Presentations.Open($sourceFile, -1, 0, 0)
  $pageWidth = [double]$deck.PageSetup.SlideWidth
  $pageHeight = [double]$deck.PageSetup.SlideHeight
  $scale = [Math]::Min(${deckWidth} / $pageWidth, ${deckHeight} / $pageHeight)
  $width = [Math]::Max(1, [int][Math]::Round($pageWidth * $scale))
  $height = [Math]::Max(1, [int][Math]::Round($pageHeight * $scale))
  foreach ($slide in $deck.Slides) {
    $slide.Export((Join-Path $exportFolder ($slide.SlideIndex.ToString() + '.png')), 'PNG', $width, $height)
  }
} finally {
  if ($deck) { $deck.Close(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($deck) }
  if ($app) { $app.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) }
}`;
    const scriptPath = path.join(directory, 'render.ps1');
    writeFileSync(scriptPath, '\ufeff' + script, 'utf8');
    try {
      await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, file, directory],
        { timeoutMs: 300000 },
      );
      return readdirSync(directory)
        .filter((f) => /^\d+\.png$/.test(f))
        .sort((a, b) => parseInt(a) - parseInt(b))
        .map((f) => path.join(directory, f));
    } catch {
      /* Explicit fallback rendered for user review. */
    }
  }
  const executable =
    (await findTool('soffice', soffice)) ??
    [
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    ].find(existsSync);
  if (!executable)
    throw new Error('未找到 PowerPoint 或 LibreOffice。请安装其中之一，或把课件另存为 PDF/图片后导入。');
  const profile = pathToFileURL(path.join(directory, 'lo-profile')).href;
  await run(
    executable,
    [`-env:UserInstallation=${profile}`, '--headless', '--convert-to', 'pdf', '--outdir', directory, file],
    { timeoutMs: 300000 },
  );
  return renderPdf(path.join(directory, `${path.basename(file, path.extname(file))}.pdf`), directory);
}
export async function importSlides(
  store: WorkspaceStore,
  courseId: string,
  files: string[],
  append = true,
): Promise<ImportResult> {
  const warnings: string[] = [];
  const slides: Slide[] = [];
  for (const file of files) {
    const extension = path.extname(file).toLowerCase();
    if (extension === '.ppt') throw new Error('请先把旧版 .ppt 另存为 .pptx。');
    const directory = path.join(store.courseRoot(courseId), 'import', randomUUID());
    mkdirSync(directory, { recursive: true });
    let images: string[];
    let titles: string[] = [];
    let notes: string[] = [];
    if (extension === '.pptx') {
      const parsed = readPptx(file);
      titles = parsed.titles;
      notes = parsed.notes;
      warnings.push(...parsed.warnings, 'PPT 按静态页导入，请核对字体、公式和版式；动画请另行导出视频。');
      images = await renderPptx(file, directory, store.settings().sofficePath);
    } else if (extension === '.pdf') images = await renderPdf(file, directory);
    else if (['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) images = [file];
    else throw new Error('课件支持 PPTX、PDF、PNG、JPG 和 WebP。');
    for (const [index, image] of images.entries()) {
      const asset = store.addAsset(courseId, image, 'slide');
      const slide = updateNarration(
        newSlide(
          titles[index] ?? path.basename(file, extension) + (images.length > 1 ? ` · ${index + 1}` : ''),
        ),
        notes[index] ?? '',
        notes[index] ?? '',
      );
      slide.assetId = asset.id;
      slide.originalText = notes[index] ?? '';
      slides.push(slide);
    }
    store.addAsset(courseId, file, 'document');
  }
  const course = append ? store.mutate(courseId, (c) => c.slides.push(...slides)) : store.get(courseId);
  const missing = course.slides.filter((s) => !s.spokenText.trim()).length;
  if (missing) warnings.push(`${missing} 页尚无讲稿，可读取备注或逐页填写。`);
  return { course, warnings, stagedSlides: append ? undefined : slides };
}
export function importScript(store: WorkspaceStore, courseId: string, file: string): ImportResult {
  let text: string;
  if (path.extname(file).toLowerCase() === '.docx') {
    const archive = unzipSync(new Uint8Array(readFileSync(file)), {
      filter: (f) => {
        if (f.originalSize > 32 * 1024 ** 2) throw new Error('文档过大');
        return f.name === 'word/document.xml';
      },
    });
    if (!archive['word/document.xml']) throw new Error('无效的 Word 文档');
    const body = xml.parse(strFromU8(archive['word/document.xml']))['w:document']['w:body'];
    const paragraphs = body['w:p'] ?? [];
    text = (Array.isArray(paragraphs) ? paragraphs : [paragraphs])
      .map(allText)
      .map((a) => a.join(''))
      .join('\n');
  } else text = readFileSync(file, 'utf8');
  const { pages, warnings } = parsePageScript(text);
  const course = store.mutate(courseId, (c) => {
    for (const [page, body] of pages) {
      const slide = c.slides[page - 1];
      if (!slide) warnings.push(`讲稿第 ${page} 页无对应课件，未导入。`);
      else c.slides[page - 1] = { ...updateNarration(slide, body, body), originalText: body };
    }
  });
  return { course, warnings };
}
