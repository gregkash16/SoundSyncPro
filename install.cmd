@echo off
setlocal
set "SRC=%~dp0"
if "%SRC:~-1%"=="\" set "SRC=%SRC:~0,-1%"
set "DST=%APPDATA%\Adobe\CEP\extensions\com.gregk.soundsyncpro"

echo Enabling unsigned CEP panels (PlayerDebugMode)...
reg add "HKCU\Software\Adobe\CSXS.11" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul
reg add "HKCU\Software\Adobe\CSXS.12" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul

if not exist "%APPDATA%\Adobe\CEP\extensions" mkdir "%APPDATA%\Adobe\CEP\extensions"
if exist "%DST%" rmdir "%DST%" 2>nul
echo Linking %DST% -^> %SRC%
mklink /J "%DST%" "%SRC%"

echo.
echo ffmpeg: looked up in bin\, then C:\ffmpeg\bin, then PATH.
echo Done. Restart Premiere Pro, then Window ^> Extensions ^> SoundSyncPro
pause
