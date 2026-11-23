const { existsSync, statSync } = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
module.exports = ({ packager }) => {
  const appDir = packager.projectDir;
  const exe = path.join(appDir, 'resources', 'page-join', 'page-join.exe');
  const inputs = ['render.py', 'build.ps1'].map((f) => path.join(appDir, 'scripts', 'page-join', f));
  if (existsSync(exe) && inputs.every((f) => statSync(f).mtimeMs <= statSync(exe).mtimeMs)) return;
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', inputs[1]], {
    cwd: appDir,
    windowsHide: true,
    stdio: 'inherit',
  });
};
