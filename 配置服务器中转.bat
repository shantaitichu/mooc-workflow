@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
pushd "%~dp0" || exit /b 1
node.exe scripts\pair-media-relay.mjs
set "relayExit=%errorlevel%"
popd
pause
exit /b %relayExit%
