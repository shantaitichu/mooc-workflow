import { useEffect, useRef } from 'react';
// Visual streams follow the same transport as the narration. Let the decoder run between corrections.
export function SyncedVideo({
  src,
  time,
  playing,
  className,
  onDimensions,
}: {
  src: string;
  time: number;
  playing: boolean;
  className?: string;
  onDimensions?: (width: number, height: number) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  function sync() {
    const v = ref.current;
    if (!v || v.readyState < 1) return;
    const dest = Math.max(
      0,
      Math.min(time, Number.isFinite(v.duration) ? Math.max(0, v.duration - 0.001) : time),
    );
    if (Math.abs(v.currentTime - dest) > (playing ? 0.12 : 0.015) && !v.seeking) v.currentTime = dest;
    if (playing && time < v.duration) {
      if (v.paused) void v.play().catch(() => {});
    } else if (!v.paused) v.pause();
  }
  useEffect(sync, [src, time, playing]);
  return (
    <video
      className={className}
      ref={ref}
      src={src}
      preload="auto"
      muted
      playsInline
      onLoadedMetadata={(event) => {
        const { videoWidth, videoHeight } = event.currentTarget;
        if (videoWidth && videoHeight) onDimensions?.(videoWidth, videoHeight);
        sync();
      }}
      onSeeked={sync}
      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
    />
  );
}
