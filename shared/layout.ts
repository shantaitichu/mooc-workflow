import type { CompositionSettings, Course, Layout } from './types';
import { defaultComposition } from './domain';
export const minDeckScale = 10;
export const maxDeckScale = 200;

export function canvasTitleColor(backgroundColor: string) {
  const linear = (offset: number) => {
    const value = parseInt(backgroundColor.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * linear(1) + 0.7152 * linear(3) + 0.0722 * linear(5);
  return luminance > 0.179 ? '#101820' : '#ffffff';
}
export const layoutNames: Record<Layout, string> = {
  split: '左右分栏',
  pip: '课件＋人物小窗',
  slides: '纯课件配音',
  presenter: '人物＋背景',
};
export function presets(course: Course) {
  const saved = course.layoutPresets ?? [];
  const builtin = Object.entries(layoutNames).map(([id, name]) => ({
    id,
    name,
    settings: {
      ...defaultComposition,
      layout: id as Layout,
      presenterScale: id === 'split' ? 25 : id === 'pip' ? 18 : 33,
      presenterX: id === 'presenter' ? 50 : 97,
      presenterY: id === 'pip' ? 90 : 50,
      deckScale: id === 'split' ? 69 : 100,
      deckX: id === 'split' ? 8 : 50,
      deckY: 50,
    },
  }));
  return [
    ...builtin.map((p) => saved.find((s) => s.id === p.id) ?? p),
    ...saved.filter((s) => !(s.id in layoutNames)),
  ];
}
export function geometry(o: CompositionSettings) {
  const box = (w: number, h: number, x: number, y: number) => ({
    w,
    h,
    x: Math.round(((1920 - w) * x) / 100),
    y: Math.round(((1080 - h) * y) / 100),
  });
  const dw = (1920 * (o.deckScale ?? (o.layout === 'split' ? 69 : 100))) / 100;
  const deck = box(dw, (dw * 9) / 16, o.deckX ?? (o.layout === 'split' ? 8 : 50), o.deckY ?? 50);
  if (o.deckLeft !== undefined) deck.x = Math.round((1920 * o.deckLeft) / 100);
  if (o.deckTop !== undefined) deck.y = Math.round((1080 * o.deckTop) / 100);
  const pw = Math.round((1920 * o.presenterScale) / 200) * 2;
  return {
    deck,
    person: box(pw, Math.min(880, Math.round((pw * 1.5) / 2) * 2), o.presenterX, o.presenterY),
    margin: Math.round((o.subtitleBottom ?? 6.25) * 10.8),
  };
}
