import { Crosshair, Pipette } from 'lucide-react';
import { geometry, maxDeckScale, minDeckScale } from '../shared/layout';
import type { CompositionSettings } from '../shared/types';
import './canvas-settings.css';

const roundPercent = (n: number) => Math.round(n * 100) / 100;

export function CanvasSettings({
  settings,
  hasDeck,
  change,
  sampling,
  toggleSampling,
  canSample,
}: {
  settings: CompositionSettings;
  hasDeck: boolean;
  change: (patch: Partial<CompositionSettings>) => void;
  sampling: boolean;
  toggleSampling: () => void;
  canSample: boolean;
}) {
  const { deck } = geometry(settings);
  const scale = roundPercent((deck.w / 1920) * 100);
  const left = settings.deckLeft ?? roundPercent((deck.x / 1920) * 100);
  const top = settings.deckTop ?? roundPercent((deck.y / 1080) * 100);
  return (
    <section className="canvas-settings" aria-label="画布与课件">
      <h3>画布与课件</h3>
      <div className="canvas-colors">
        <label className="canvas-swatch">
          <input
            aria-label="画布底色"
            type="color"
            value={settings.backgroundColor}
            onChange={(e) => change({ backgroundColor: e.target.value })}
          />
          <span>
            画布底色 <code>{settings.backgroundColor.toUpperCase()}</code>
          </span>
        </label>
        {canSample && (
          <button
            type="button"
            className="canvas-eyedropper"
            onClick={toggleSampling}
            aria-pressed={sampling}
          >
            <Pipette size={14} />
            {sampling ? '取消取色' : '从预览取色'}
          </button>
        )}
      </div>
      {sampling && <p role="status">点击预览中的颜色，按 Esc 取消。</p>}
      {hasDeck && (
        <>
          <label className="field">
            <span>
              课件缩放 <output>{scale}%</output>
            </span>
            <input
              type="range"
              aria-label="课件缩放"
              min={minDeckScale}
              max={maxDeckScale}
              step="0.1"
              value={scale}
              onChange={(e) => {
                const next = e.target.valueAsNumber;
                change({
                  deckScale: next,
                  deckLeft: roundPercent(left + (scale - next) / 2),
                  deckTop: roundPercent(top + (scale - next) / 2),
                });
              }}
            />
          </label>
          <div className="two-fields">
            {(
              [
                ['deckLeft', '课件左侧位置', left],
                ['deckTop', '课件顶部位置', top],
              ] as const
            ).map(([key, label, value]) => (
              <label key={key} className="field">
                <span>{label}（%）</span>
                <input
                  type="number"
                  step="any"
                  value={value}
                  onChange={(e) => {
                    const next = e.target.valueAsNumber;
                    if (Number.isFinite(next)) change({ [key]: next });
                  }}
                />
              </label>
            ))}
          </div>
          <button
            type="button"
            className="canvas-center"
            onClick={() =>
              change({
                deckLeft: (100 - scale) / 2,
                deckTop: (100 - scale) / 2,
              })
            }
          >
            <Crosshair size={13} /> 课件居中
          </button>
          <p>拖动预览中的课件可移动位置，拖动角点可等比缩放。</p>
        </>
      )}
    </section>
  );
}
