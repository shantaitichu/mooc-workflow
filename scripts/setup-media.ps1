$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$downloadDir = Join-Path $workspace '.data/downloads'
$archive = Join-Path $downloadDir 'ffmpeg-9.0.2.7z'
$extracted = Join-Path $downloadDir 'ffmpeg-9.0.2'
$destination = Join-Path $workspace 'resources/bin'
$expectedHash = '4705843ccaaf54257c16ad90f3e952ece33c17df964ecf7bfdbb0f49c7171077'
New-Item -ItemType Directory -Force -Path $downloadDir, $destination | Out-Null
if (!(Test-Path -LiteralPath $archive)) {
  Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.7z' -OutFile $archive
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) { throw 'FFmpeg archive checksum mismatch; archive was not executed or extracted.' }
$extractor = Join-Path $workspace 'node_modules/electron-winstaller/vendor/7z-x64.exe'
if (!(Test-Path -LiteralPath $extractor)) { throw 'Run npm ci first.' }
& $extractor x $archive "-o$extracted" -y
if ($LASTEXITCODE -ne 0) { throw 'FFmpeg extraction failed.' }
$source = Join-Path $extracted 'ffmpeg-9.0.2-essentials_build'
Copy-Item -LiteralPath (Join-Path $source 'bin/ffmpeg.exe') -Destination (Join-Path $destination 'ffmpeg.exe')
Copy-Item -LiteralPath (Join-Path $source 'bin/ffprobe.exe') -Destination (Join-Path $destination 'ffprobe.exe')
Copy-Item -LiteralPath (Join-Path $source 'LICENSE') -Destination (Join-Path $destination 'FFMPEG-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $source 'README.txt') -Destination (Join-Path $destination 'FFMPEG-README.txt')
Write-Output 'Verified FFmpeg/FFprobe 9.0.2 are ready in resources/bin.'
