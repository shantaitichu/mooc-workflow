import { useEffect, useRef, useState } from 'react';
export function Waveform({ url }: { url: string }) {
  const [peaks, setPeaks] = useState<number[]>([]);
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const abort = new AbortController();
    const context = new AudioContext();
    void (async () => {
      try {
        const response = await fetch(url, { signal: abort.signal });
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        const data = buffer.getChannelData(0);
        const size = Math.max(1, Math.floor(data.length / 72));
        const result = Array.from({ length: 72 }, (_, i) => {
          let peak = 0;
          for (let j = i * size; j < Math.min(data.length, (i + 1) * size); j++)
            peak = Math.max(peak, Math.abs(data[j]));
          return peak;
        });
        if (!abort.signal.aborted) setPeaks(result);
      } catch {
        /* Audio controls remain usable when the preview decoder cannot handle a format. */
      } finally {
        if (context.state !== 'closed') await context.close();
      }
    })();
    return () => {
      abort.abort();
    };
  }, [url]);
  return (
    <div className="waveform-control">
      {peaks.length > 0 && (
        <button
          className="waveform"
          aria-label="点击波形定位音频"
          onClick={(e) => {
            if (audio.current && Number.isFinite(audio.current.duration))
              audio.current.currentTime =
                ((e.clientX - e.currentTarget.getBoundingClientRect().left) / e.currentTarget.clientWidth) *
                audio.current.duration;
          }}
        >
          {peaks.map((p, i) => (
            <i key={i} style={{ height: `${Math.max(2, p * 30)}px` }} />
          ))}
        </button>
      )}
      <audio ref={audio} controls preload="metadata" src={url} />
    </div>
  );
}
