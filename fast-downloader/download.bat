@echo off
chcp 65001 >nul
title Fast Downloader
cd /d "%~dp0"

echo ===============================
echo   Fast Downloader
echo ===============================
echo.

REM --- Check that Node.js is installed ---
where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js is not installed.
  echo     Install the LTS version from https://nodejs.org then run this again.
  echo.
  pause
  exit /b 1
)

REM --- Ask for the download URL ---
set "URL="
set /p "URL=Paste the download link and press Enter: "
if "%URL%"=="" (
  echo.
  echo [!] No link entered.
  pause
  exit /b 1
)

REM --- Ask for the output file name (default: output.bin) ---
set "OUT="
set /p "OUT=Output file name (press Enter for output.bin): "
if "%OUT%"=="" set "OUT=output.bin"

REM --- Ask for number of connections (default: 8) ---
set "CONN="
set /p "CONN=Number of connections (press Enter for 8): "
if "%CONN%"=="" set "CONN=8"

echo.
echo Downloading...
echo.
node "%~dp0downloader.js" "%URL%" "%OUT%" %CONN%

echo.
echo Done. File saved in this folder: %OUT%
echo.
pause
