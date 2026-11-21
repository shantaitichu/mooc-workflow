# Local media tools

This local Windows trial bundles the separate FFmpeg and FFprobe executables from
Gyan's FFmpeg 9.0.2 essentials build (2026-09-19). Their license and original
README are included alongside them. They run as separate local processes.

- Build source: https://www.gyan.dev/ffmpeg/builds/
- Archive: https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.7z
- Archive SHA256: `4705843ccaaf54257c16ad90f3e952ece33c17df964ecf7bfdbb0f49c7171077`
- FFmpeg source revision: https://github.com/FFmpeg/FFmpeg/commit/946fcce07b
- Source and build references: see `FFMPEG-README.txt`.

Executables are excluded from source control. Run `npm run setup:media` to fetch
and verify this exact archive. Preserve third-party notices and complete the
corresponding-source distribution materials before public redistribution.
