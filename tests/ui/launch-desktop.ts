import { _electron as electron } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function launchDesktop(data: string) {
  const { build } = JSON.parse(readFileSync('package.json', 'utf8'));
  const executablePath = path.resolve(build.directories.output, 'win-unpacked', build.productName + '.exe');
  return electron.launch({
    ...(process.env.MOOC_TEST_PACKAGED ? { executablePath } : { args: ['.'] }),
    env: { ...process.env, MOOC_DATA_DIR: data, MOOC_HEADLESS: '1' },
  });
}
