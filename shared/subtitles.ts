export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}
const timestamp = (ms: number) => {
  const n = Math.round(ms);
  return `${Math.floor(n / 3600000)
    .toString()
    .padStart(2, '0')}:${Math.floor((n / 60000) % 60)
    .toString()
    .padStart(2, '0')}:${Math.floor((n / 1000) % 60)
    .toString()
    .padStart(2, '0')},${(n % 1000).toString().padStart(3, '0')}`;
};
export const toSrt = (cues: Cue[]) =>
  cues
    .map(
      (cue, i) =>
        `${i + 1}\n${timestamp(cue.startMs)} --> ${timestamp(cue.endMs)}\n${cue.text.replace(/\r/g, '').trim()}\n`,
    )
    .join('\n');
export function captionCues(text: string, startMs: number, durationMs: number): Cue[] {
  const parts =
    text
      .replace(/\[停顿\s*\d+\s*ms\]/g, '')
      .match(/.{1,24}(?:[，。！？；、,.!?;]|$)|.{1,24}/gu)
      ?.map((s) => s.trim())
      .filter(Boolean) ?? [];
  const length = parts.reduce((sum, p) => sum + Array.from(p).length, 0);
  let cursor = startMs;
  return parts.map((part, i) => {
    const end =
      i === parts.length - 1
        ? startMs + durationMs
        : cursor + (durationMs * Array.from(part).length) / length;
    const cue = { startMs: Math.round(cursor), endMs: Math.round(end), text: part };
    cursor = end;
    return cue;
  });
}

export interface CaptionPart {
  text: string;
  durationMs: number;
}

export function pageCaptionCues(authored: string, parts: CaptionPart[]): Cue[] {
  const compact = (text: string) => text.replace(/\s/g, '');
  if (authored && compact(authored) !== compact(parts.map((part) => part.text).join('')))
    return captionCues(
      authored,
      0,
      parts.reduce((sum, part) => sum + part.durationMs, 0),
    );
  let cursor = 0;
  return parts.flatMap((part) => {
    const cues = captionCues(part.text, cursor, part.durationMs);
    cursor += part.durationMs;
    return cues;
  });
}

export const captionFrameMs = 40;
export function captionAt(cues: Cue[], timeMs: number) {
  const frameMs = Math.floor(timeMs / captionFrameMs) * captionFrameMs;
  return cues.find((cue) => cue.startMs <= frameMs && frameMs < cue.endMs)?.text ?? '';
}

// The baseline and raster are both expressed in the 1920×1080 composition's pixels.
// The even top coordinate is also representable by FFmpeg's 4:2:0 overlay filter.
export function captionStrip(size: number, bottom: number) {
  const baseline = Math.ceil((size * 1.25) / 2) * 2 + 4;
  const height = baseline + Math.ceil((size * 0.5) / 2) * 2 + 4;
  return { width: 1920, height, baseline, y: 2 * Math.round((1080 - bottom - baseline) / 2) };
}

type TextBrush = Pick<
  CanvasRenderingContext2D,
  'font' | 'textAlign' | 'textBaseline' | 'lineWidth' | 'lineJoin' | 'strokeText' | 'fillText'
> & { strokeStyle: unknown; fillStyle: unknown };
export function drawCaption(context: TextBrush, text: string, size: number) {
  const { width, baseline } = captionStrip(size, 0);
  context.font = size + 'px "Microsoft YaHei", sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'alphabetic';
  context.lineJoin = 'round';
  context.lineWidth = 4;
  context.strokeStyle = '#14202a';
  context.fillStyle = '#ffffff';
  context.strokeText(text, width / 2, baseline, width - 48);
  context.fillText(text, width / 2, baseline, width - 48);
}
