import { useMemo } from 'react';
import { captionStrip, drawCaption } from '../shared/subtitles';

export function CaptionLayer({ text, size, bottom }: { text: string; size: number; bottom: number }) {
  const { width, height, y } = captionStrip(size, bottom);
  const href = useMemo(() => {
    if (window.mooc) {
      const params = new URLSearchParams({ size: String(size), text });
      return 'mooc://caption/strip?' + params.toString();
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    drawCaption(canvas.getContext('2d')!, text, size);
    return canvas.toDataURL();
  }, [text, size, width, height]);
  return (
    <image href={href} x={0} y={y} width={width} height={height} aria-label={text} pointerEvents="none" />
  );
}
