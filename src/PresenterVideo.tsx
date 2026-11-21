import { useEffect, useState } from 'react';
import type { MediaInfo } from '../shared/types';
import { driverAperture, fitPresenter } from '../shared/presenter-frame';
import { SyncedVideo } from './SyncedVideo';

type Dimensions = Pick<MediaInfo, 'width' | 'height'>;

// Older portable projects can contain a working transparent idle video without its stored dimensions.
export function useIdleDimensions(src: string | undefined, info?: MediaInfo): Dimensions | undefined {
  const [read, setRead] = useState<{ src: string; width: number; height: number }>();
  useEffect(() => {
    if (!src || (info?.width && info.height)) return;
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => setRead({ src, width: video.videoWidth, height: video.videoHeight });
    video.src = src;
    return () => {
      video.onloadedmetadata = null;
      video.removeAttribute('src');
      video.load();
    };
  }, [src, info?.width, info?.height]);
  return info?.width && info.height ? info : read?.src === src ? read : undefined;
}

export function PresenterVideo({
  box,
  src,
  info,
  driverReference,
  time,
  playing,
}: {
  box: { x: number; y: number; w: number; h: number };
  src: string;
  info?: MediaInfo;
  driverReference?: Dimensions;
  time: number;
  playing: boolean;
}) {
  const [loaded, setLoaded] = useState<{ src: string; width: number; height: number }>();
  const size = loaded?.src === src ? loaded : info;
  const crop = driverAperture(driverReference, size);
  const frame =
    size?.width && size.height ? fitPresenter(box, crop ?? { w: size.width, h: size.height }) : box;
  return (
    <foreignObject x={frame.x} y={frame.y} width={frame.w} height={frame.h}>
      <div style={{ position: 'relative', overflow: 'hidden', width: '100%', height: '100%' }}>
        <div
          style={
            crop && size?.width && size.height
              ? {
                  position: 'absolute',
                  left: (-100 * crop.x) / crop.w + '%',
                  top: (-100 * crop.y) / crop.h + '%',
                  width: (100 * size.width) / crop.w + '%',
                  height: (100 * size.height) / crop.h + '%',
                }
              : { width: '100%', height: '100%' }
          }
        >
          <SyncedVideo
            src={src}
            time={time}
            playing={playing}
            onDimensions={(width, height) => setLoaded({ src, width, height })}
          />
        </div>
      </div>
    </foreignObject>
  );
}
