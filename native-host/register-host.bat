@echo off
:: Reamlet — native messaging host registration
:: Run this once after extracting the portable build, or after moving it.
:: The NSIS installer runs this automatically.
::
:: Usage: double-click register-host.bat, or run from any prompt.

setlocal EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "HOST_EXE=%SCRIPT_DIR%\reamlet-native-host.exe"
set "MANIFEST=%SCRIPT_DIR%\com.reamlet.chromebridge.json"

if not exist "%HOST_EXE%" (
    echo ERROR: reamlet-native-host.exe not found in %SCRIPT_DIR%
    pause
    exit /b 1
)

:: Write the manifest with the resolved exe path (escape backslashes for JSON).
set "JSON_PATH=%HOST_EXE:\=\\%"
(
  echo {
  echo   "name": "com.reamlet.chromebridge",
  echo   "description": "Reamlet native messaging host",
  echo   "path": "%JSON_PATH%",
  echo   "type": "stdio",
  echo   "allowed_origins": [
  echo     "chrome-extension://PLACEHOLDER_CHROME_ID/",
  echo     "chrome-extension://PLACEHOLDER_EDGE_ID/",
  echo     "chrome-extension://PLACEHOLDER_BRAVE_ID/"
  echo   ]
  echo }
) > "%MANIFEST%"

set "KEY_NAME=com.reamlet.chromebridge"

set BROWSERS[0]=HKCU\Software\Google\Chrome\NativeMessagingHosts
set BROWSERS[1]=HKCU\Software\Microsoft\Edge\NativeMessagingHosts
set BROWSERS[2]=HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts
set BROWSERS[3]=HKCU\Software\Vivaldi\NativeMessagingHosts
set BROWSERS[4]=HKCU\Software\Opera Software\Opera\NativeMessagingHosts
set BROWSERS[5]=HKCU\Software\Opera Software\Opera GX\NativeMessagingHosts

for /L %%i in (0,1,5) do (
    reg add "!BROWSERS[%%i]!\%KEY_NAME%" /ve /t REG_SZ /d "%MANIFEST%" /f >nul 2>&1
    if !ERRORLEVEL! == 0 (
        echo Registered: !BROWSERS[%%i]!
    ) else (
        echo Skipped ^(not installed^): !BROWSERS[%%i]!
    )
)

echo.
echo Done. Restart your browser if it was already open.
pause
