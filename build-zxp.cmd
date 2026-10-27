@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-zxp.ps1" %*
pause
