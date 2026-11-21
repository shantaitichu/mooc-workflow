import { useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { resolveTrack } from '../shared/motion-track';
import type { Course, Slide, CompositionSettings } from '../shared/types';
import { compositionFor, readyMotion } from '../shared/domain';
import { canvasTitleColor, geometry, maxDeckScale, minDeckScale } from '../shared/layout';
import { api } from './api';
import { SyncedVideo } from './SyncedVideo';
import { PresenterVideo, useIdleDimensions } from './PresenterVideo';
import { CaptionLayer } from './CaptionLayer';
import './layout-stage.css';

type Box = ReturnType<typeof geometry>['deck'];
const corners = ['nw', 'ne', 'se', 'sw'] as const;
type Handle = (typeof corners)[number];
const cornerNames: Record<Handle, string> = { nw: '左上', ne: '右上', se: '右下', sw: '左下' };
const stageWidth = 1920,
  stageHeight = 1080;
const percent = (value: number, total: number) => Math.round((value / total) * 10000) / 100;

function pictureBounds(box: Box, ratio: number) {
  const w = Math.min(box.w, box.h * ratio);
  const h = w / ratio;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

function resizeDeck(deck: Box, picture: Box, corner: Handle, dx: number, dy: number) {
  const west = corner.endsWith('w'),
    north = corner.startsWith('n');
  const diagonalX = west ? -picture.w : picture.w,
    diagonalY = north ? -picture.h : picture.h;
  const change = (dx * diagonalX + dy * diagonalY) / (picture.w ** 2 + picture.h ** 2);
  const deckScale = Math.min(
    maxDeckScale,
    Math.max(minDeckScale, percent(deck.w * (1 + change), stageWidth)),
  );
  // The opposite corner of the visible image stays fixed, including on portrait or 4:3 pages.
  const anchorX = picture.x + (west ? picture.w : 0),
    anchorY = picture.y + (north ? picture.h : 0);
  const factor = ((deckScale / 100) * stageWidth) / deck.w;
  return {
    deckScale,
    deckLeft: percent(anchorX + (deck.x - anchorX) * factor, stageWidth),
    deckTop: percent(anchorY + (deck.y - anchorY) * factor, stageHeight),
  };
}

export function LayoutStage({
  course,
  slide,
  onMove,
  timeMs = 0,
  durationMs,
  playing,
  caption,
  presenterId,
}: {
  course: Course;
  slide: Slide;
  onMove: (settings: Partial<CompositionSettings>) => void;
  timeMs?: number;
  durationMs: number;
  playing: boolean;
  caption: string;
  presenterId?: string;
}) {
  const [draft, setDraft] = useState<{ slideId: string; settings: Partial<CompositionSettings> }>();
  const options = compositionFor(course, slide);
  const { deck, person, margin } = geometry(
    draft?.slideId === slide.id && !playing ? { ...options, ...draft.settings } : options,
  );
  const svg = useRef<SVGSVGElement>(null);
  const [selectedDeck, setSelectedDeck] = useState<string>();
  const [naturalSize, setNaturalSize] = useState<{ id: string; ratio: number }>();
  const picture = pictureBounds(
    deck,
    naturalSize && naturalSize.id === slide.assetId ? naturalSize.ratio : 16 / 9,
  );
  const [unitsPerPixel, setUnitsPerPixel] = useState(3);
  useLayoutEffect(() => {
    const stage = svg.current!;
    const resize = new ResizeObserver(() => {
      const scale = stage.getScreenCTM()?.a;
      if (scale && scale > 0) setUnitsPerPixel(1 / scale);
    });
    resize.observe(stage);
    return () => resize.disconnect();
  }, []);
  const drag = useRef<{
    id: number;
    slideId: string;
    handle: 'deck' | 'person' | Handle;
    x: number;
    y: number;
    deck: Box;
    picture: Box;
    person: Box;
    presenterX: number;
    presenterY: number;
  } | null>(null);
  useLayoutEffect(() => {
    const d = drag.current;
    if (d && (d.slideId !== slide.id || playing)) {
      drag.current = null;
      setDraft(undefined);
      if (svg.current?.hasPointerCapture(d.id)) svg.current.releasePointerCapture(d.id);
    }
  }, [slide.id, playing]);
  function point(event: ReactPointerEvent) {
    const matrix = svg.current?.getScreenCTM();
    return matrix ? new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()) : undefined;
  }
  function begin(event: ReactPointerEvent, handle: 'deck' | 'person' | Handle) {
    if (event.button !== 0 || playing || drag.current) return;
    const p = point(event);
    if (!p) return;
    setSelectedDeck(handle === 'person' ? undefined : slide.id);
    svg.current!.setPointerCapture(event.pointerId);
    drag.current = {
      id: event.pointerId,
      slideId: slide.id,
      handle,
      x: p.x,
      y: p.y,
      deck,
      picture,
      person,
      presenterX: options.presenterX,
      presenterY: options.presenterY,
    };
    event.preventDefault();
    event.stopPropagation();
  }
  function pointerSettings(
    event: ReactPointerEvent,
    d: NonNullable<typeof drag.current>,
  ): Partial<CompositionSettings> | undefined {
    const p = point(event);
    if (!p) return;
    const dx = p.x - d.x,
      dy = p.y - d.y;
    if (!dx && !dy) return;
    if (d.handle === 'person') {
      return {
        presenterX: Math.round((d.presenterX + (100 * dx) / (stageWidth - d.person.w)) * 10) / 10,
        presenterY: Math.round((d.presenterY + (100 * dy) / (stageHeight - d.person.h)) * 10) / 10,
      };
    }
    if (d.handle === 'deck')
      return { deckLeft: percent(d.deck.x + dx, stageWidth), deckTop: percent(d.deck.y + dy, stageHeight) };
    return resizeDeck(d.deck, d.picture, d.handle, dx, dy);
  }
  function move(event: ReactPointerEvent) {
    const d = drag.current;
    if (!d || playing || d.slideId !== slide.id || event.pointerId !== d.id) return;
    const settings = pointerSettings(event, d);
    setDraft(settings ? { slideId: slide.id, settings } : undefined);
  }
  function finish(event: ReactPointerEvent, commit: boolean) {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    drag.current = null;
    setDraft(undefined);
    if (commit && !playing && d.slideId === slide.id) {
      const settings = pointerSettings(event, d);
      if (settings) onMove(settings);
    }
  }
  const presenterTime = Math.min(timeMs, Math.max(0, (Math.round(durationMs / 40) - 1) * 40));
  const usesPhoto = slide.videoModel === 'omnihuman-1.5';
  let action: { assetId: string; startMs: number; durationMs: number; sourceMs: number } | undefined;
  try {
    const cue = resolveTrack(course, slide, durationMs)
      .filter((t) => readyMotion(course, t.motion))
      .find((c) => presenterTime >= c.startMs && presenterTime < c.startMs + c.durationMs);
    if (cue)
      action = {
        assetId: cue.asset.id,
        startMs: cue.startMs,
        durationMs: cue.durationMs,
        sourceMs: cue.asset.info.durationMs ?? cue.durationMs,
      };
  } catch {
    /* invalid markers remain editable in the track */
  }
  const bg = course.assets.find((a) => a.id === slide.backgroundAssetId);
  const url = (id: string) => api.mediaUrl(course.id, id);
  const image = (id: string, b: { x: number; y: number; w: number; h: number }) => (
    <image href={url(id)} x={b.x} y={b.y} width={b.w} height={b.h} preserveAspectRatio="xMidYMid meet" />
  );
  const full = { x: 0, y: 0, w: 1920, h: 1080 };
  const bgDuration = Math.max(
    40,
    Math.min(bg?.info.durationMs ?? Infinity, slide.backgroundEndMs ?? Infinity) - slide.backgroundStartMs,
  );
  const bgTime =
    (slide.backgroundStartMs +
      (slide.shortBackground === 'loop' ? timeMs % bgDuration : Math.min(timeMs, bgDuration - 40))) /
    1000;
  const idle = course.assets.find((a) => a.id === course.speaker.idleAssetId && a.info.transparent);
  const idleDimensions = useIdleDimensions(idle && !usesPhoto ? url(idle.id) : undefined, idle?.info);
  const legacy = course.speaker.motions.find(
    (m) => m.id === slide.motionId && readyMotion(course, m) && m.reviewed,
  );
  const legacyAsset = legacy && course.assets.find((a) => a.id === legacy.assetId);
  const clipMs = legacyAsset?.info.durationMs;
  if (legacyAsset && clipMs && (legacy.loopable || presenterTime < clipMs)) {
    const startMs = Math.floor(presenterTime / clipMs) * clipMs;
    action = {
      assetId: legacyAsset.id,
      startMs,
      durationMs: Math.min(clipMs, durationMs - startMs),
      sourceMs: clipMs,
    };
  }
  const fade = action ? Math.max(40, Math.min(240, Math.floor((action.durationMs / 40 - 1) / 2) * 40)) : 240;
  const actionOpacity =
    action && !presenterId && !usesPhoto
      ? Math.max(
          0,
          Math.min(
            1,
            (presenterTime - action.startMs) / fade,
            (action.startMs + action.durationMs - 40 - presenterTime) / fade,
          ),
        )
      : 0;
  const presenter = (id: string, time: number, fromDriver: boolean) => (
    <PresenterVideo
      box={person}
      src={url(id)}
      info={course.assets.find((a) => a.id === id)?.info}
      driverReference={fromDriver ? idleDimensions : undefined}
      time={time}
      playing={playing && timeMs < durationMs}
    />
  );
  const assetId = slide.assetId;
  const showDeck = assetId && options.layout !== 'presenter';
  const visibleLeft = Math.max(0, picture.x),
    visibleTop = Math.max(0, picture.y);
  const visibleRight = Math.min(stageWidth, picture.x + picture.w),
    visibleBottom = Math.min(stageHeight, picture.y + picture.h);
  return (
    <svg
      ref={svg}
      onPointerDown={() => setSelectedDeck(undefined)}
      onPointerMove={move}
      onPointerUp={(e) => finish(e, true)}
      onPointerCancel={(e) => finish(e, false)}
      onLostPointerCapture={(e) => finish(e, false)}
      role="group"
      aria-label="页面实时布局预览"
      className="layout-stage"
      viewBox="0 0 1920 1080"
    >
      <rect
        className="canvas-background"
        width={stageWidth}
        height={stageHeight}
        fill={options.backgroundColor}
      />
      {bg &&
        (bg.kind === 'video' ? (
          <foreignObject x="0" y="0" width="1920" height="1080">
            <SyncedVideo src={url(bg.id)} time={bgTime} playing={playing} />
          </foreignObject>
        ) : (
          image(bg.id, full)
        ))}
      {showDeck ? (
        <g>
          <foreignObject x={deck.x} y={deck.y} width={deck.w} height={deck.h} pointerEvents="none">
            <img
              key={assetId}
              className="stage-deck-image"
              src={url(assetId)}
              alt=""
              draggable={false}
              onLoad={(event) => {
                const { naturalWidth, naturalHeight } = event.currentTarget;
                if (naturalWidth && naturalHeight)
                  setNaturalSize({ id: assetId, ratio: naturalWidth / naturalHeight });
              }}
            />
          </foreignObject>
          {!playing && (
            <rect
              className="deck-hit"
              aria-label="拖动 PPT 位置"
              x={picture.x}
              y={picture.y}
              width={picture.w}
              height={picture.h}
              fill="transparent"
              onPointerDown={(e) => begin(e, 'deck')}
            />
          )}
        </g>
      ) : (
        !bg && (
          <text
            fontFamily="Microsoft YaHei, sans-serif"
            fontSize="64"
            fontWeight="bold"
            fill={canvasTitleColor(options.backgroundColor)}
          >
            {slide.title.match(/.{1,20}/gu)?.map((line, i) => (
              <tspan key={i} x="100" y={360 + i * 90}>
                {line}
              </tspan>
            ))}
          </text>
        )
      )}
      {options.logoAssetId && (
        <g pointerEvents="none">{image(options.logoAssetId, { x: 55, y: 30, w: 180, h: 75 })}</g>
      )}
      {options.layout !== 'slides' && !slide.keepBackgroundAudio && (
        <g className="movable-person" onPointerDown={(e) => begin(e, 'person')} aria-label="拖动讲师位置">
          <g opacity={1 - actionOpacity}>
            {presenterId ? (
              presenter(presenterId, presenterTime / 1000, !usesPhoto)
            ) : !usesPhoto && idle ? (
              presenter(idle.id, (presenterTime % (idle.info.durationMs || 40)) / 1000, false)
            ) : course.speaker.imageAssetId ? (
              image(course.speaker.imageAssetId, person)
            ) : (
              <g>
                <rect x={person.x} y={person.y} width={person.w} height={person.h} fill="#42616b" rx="15" />
                <text
                  x={person.x + person.w / 2}
                  y={person.y + person.h / 2}
                  textAnchor="middle"
                  fill="white"
                  fontSize="32"
                >
                  讲师画面
                </text>
              </g>
            )}
          </g>
          {action && !presenterId && !usesPhoto && (
            <g opacity={actionOpacity}>
              {presenter(
                action.assetId,
                ((presenterTime - action.startMs) * action.sourceMs) / Math.max(1, action.durationMs) / 1000,
                true,
              )}
            </g>
          )}
          <rect
            className="person-hit"
            x={person.x}
            y={person.y}
            width={person.w}
            height={person.h}
            fill="transparent"
            stroke="transparent"
            strokeWidth="3"
          />
        </g>
      )}
      {options.burnSubtitles && caption && (
        <CaptionLayer text={caption} size={options.subtitleSize} bottom={margin} />
      )}
      <rect x="1606" y="24" width="290" height="48" fill="#102934bb" pointerEvents="none" />
      <text
        x="1618"
        y="56"
        fontFamily="Microsoft YaHei, sans-serif"
        fontSize="22"
        fill="white"
        pointerEvents="none"
      >
        AI 生成合成 · 数字人
      </text>
      {showDeck && !playing && visibleRight > visibleLeft && visibleBottom > visibleTop && (
        <g className={'deck-controls' + (selectedDeck === slide.id ? ' selected' : '')}>
          <rect className="deck-outline" x={picture.x} y={picture.y} width={picture.w} height={picture.h} />
          {corners.map((corner) => {
            // Inset clipped handles just far enough to remain easy to grab at the canvas edge.
            const insetX = Math.min(6 * unitsPerPixel, (visibleRight - visibleLeft) / 4);
            const insetY = Math.min(6 * unitsPerPixel, (visibleBottom - visibleTop) / 4);
            const x = corner.endsWith('w')
              ? Math.max(visibleLeft, insetX)
              : Math.min(visibleRight, stageWidth - insetX);
            const y = corner.startsWith('n')
              ? Math.max(visibleTop, insetY)
              : Math.min(visibleBottom, stageHeight - insetY);
            return (
              <g
                key={corner}
                className="deck-handle"
                data-corner={corner}
                aria-label={'从' + cornerNames[corner] + '角缩放 PPT'}
                onPointerDown={(e) => begin(e, corner)}
              >
                <circle cx={x} cy={y} r={9 * unitsPerPixel} fill="transparent" />
                <rect
                  x={x - 4 * unitsPerPixel}
                  y={y - 4 * unitsPerPixel}
                  width={8 * unitsPerPixel}
                  height={8 * unitsPerPixel}
                  rx={1.5 * unitsPerPixel}
                  className="deck-grip"
                />
              </g>
            );
          })}
        </g>
      )}
    </svg>
  );
}
