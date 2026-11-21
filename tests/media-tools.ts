import path from 'node:path';
import { existsSync } from 'node:fs';
export const ffmpeg = path.resolve(
  existsSync('resources/bin/ffmpeg.exe')
    ? 'resources/bin/ffmpeg.exe'
    : 'node_modules/ffmpeg-static/ffmpeg.exe',
);
export const ffprobe = path.resolve(
  existsSync('resources/bin/ffprobe.exe')
    ? 'resources/bin/ffprobe.exe'
    : 'node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe',
);
