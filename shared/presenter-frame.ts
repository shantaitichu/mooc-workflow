// Older projects used this padded portrait frame for lip-sync and joined motion assets.
const legacyDriverSize = { width: 640, height: 960 };

type Dimensions = { width?: number; height?: number };
type Rect = { x: number; y: number; w: number; h: number };

// Only a video made from our padded driver has a removable aperture.
// Keep all transparent margins already present in the lecturer's original framing.
export function driverAperture(reference?: Dimensions, video?: Dimensions): Rect | undefined {
  if (!reference?.width || !reference.height || !video?.width || !video.height) return;
  if (reference.width === video.width && reference.height === video.height) return;
  const { width, height } = legacyDriverSize;
  if (Math.abs((video.width * height) / width - video.height) > 2) return;
  const fit = Math.min(width / reference.width, height / reference.height);
  // FFmpeg's scale rounds to the closest pixel, then rounds down for 4:2:0.
  const even = (v: number) => 2 * Math.floor(Math.round(v) / 2);
  const w = Math.max(2, even(reference.width * fit));
  const h = Math.max(2, even(reference.height * fit));
  if (w === width && h === height) return;
  // pad aligns its offset to a chroma sample. Scale the aperture if the provider resized the frame.
  return {
    x: even((2 * Math.floor((width - w) / 4) * video.width) / width),
    y: even((2 * Math.floor((height - h) / 4) * video.height) / height),
    w: Math.max(2, even((w * video.width) / width)),
    h: Math.max(2, even((h * video.height) / height)),
  };
}

export function fitPresenter(box: Rect, source: { w: number; h: number }): Rect {
  const scale = Math.min(box.w / source.w, box.h / source.h);
  const w = Math.max(2, 2 * Math.round((source.w * scale) / 2));
  const h = Math.max(2, 2 * Math.round((source.h * scale) / 2));
  // The final 4:2:0 video overlays on even coordinates. Match those coordinates in the preview.
  return {
    x: 2 * Math.floor((box.x + (box.w - w) / 2) / 2),
    y: 2 * Math.floor((box.y + (box.h - h) / 2) / 2),
    w,
    h,
  };
}
