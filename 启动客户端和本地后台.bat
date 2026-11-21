@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
pushd "%~dp0" || exit /b 1
where node.exe >nul 2>&1
if errorlevel 1 goto missing
node.exe scripts\start-local.mjs
if errorlevel 1 goto failed
popd
exit /b 0
:missing
echo 本地后台需要 Node.js 24 或更高版本，请检查 PATH。
:failed
pause
popd
exit /b 1
