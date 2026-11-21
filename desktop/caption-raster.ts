import { createCanvas } from '@napi-rs/canvas';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { captionFrameMs, captionStrip, drawCaption, type Cue } from '../shared/subtitles';

export function captionPng(text: string, size: number) {
  const { width, height } = captionStrip(size, 0);
  const canvas = createCanvas(width, height);
  if (text) drawCaption(canvas.getContext('2d'), text, size);
  return canvas.toBuffer('image/png');
}

/** A sparse timed PNG stream, with explicit transparent frames for gaps and the page's trailing pause. */
export function writeCaptionTrack(directory: string, cues: Cue[], size: number) {
  const frames = new Map<number, string>([[0, '']]);
  for (const cue of cues) {
    const first = Math.max(0, Math.ceil(cue.startMs / captionFrameMs));
    const after = Math.ceil(cue.endMs / captionFrameMs);
    if (after <= first) continue;
    frames.set(first, cue.text);
    frames.set(after, '');
  }
  const images = new Map<string, string>();
  const sequence = [...frames].sort(([a], [b]) => a - b);
  const lines = ['ffconcat version 1.0'];
  for (const [index, [frame, text]] of sequence.entries()) {
    let file = images.get(text);
    if (!file) {
      file = 'caption-' + images.size + '.png';
      writeFileSync(path.join(directory, file), captionPng(text, size));
      images.set(text, file);
    }
    lines.push('file ' + file);
    if (index + 1 < sequence.length)
      lines.push('duration ' + (((sequence[index + 1][0] - frame) * captionFrameMs) / 1000).toFixed(3));
  }
  const manifest = path.join(directory, 'captions.ffconcat');
  writeFileSync(manifest, lines.join('\n') + '\n');
  return manifest;
}
