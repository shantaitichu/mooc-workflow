# Build the redistributable Windows helper in an isolated environment.
$ErrorActionPreference = 'Stop'
$build = Join-Path $PSScriptRoot '../../.data/join-build-env'
$python = Join-Path $build 'Scripts/python.exe'
if (!(Test-Path -LiteralPath $python)) {
  python -m venv $build
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
}
& $python -m pip install --disable-pip-version-check opencv-python-headless==4.12.0.88 numpy==2.2.6 pyinstaller==6.17.0
if ($LASTEXITCODE) { exit $LASTEXITCODE }
$cascade = Join-Path $build 'Lib/site-packages/cv2/data/haarcascade_frontalface_default.xml'
& $python -m PyInstaller --add-data "${cascade};cv2/data" --noconfirm --onedir --noupx --log-level WARN --name page-join --workpath .data/join-build --specpath .data/join-spec --distpath resources scripts/page-join/render.py
exit $LASTEXITCODE
