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

:: Read allowed_origins from the existing manifest, then rewrite the whole
:: file with the correct path stamped in. Uses a here-string in PowerShell
:: so cmd never has to echo lines containing double-quotes.
set "JSON_PATH=%HOST_EXE:\=\\%"
set "PS_FILE=%TEMP%\reamlet_reg_%RANDOM%.ps1"
(
  echo $manifest  = '%MANIFEST%'
  echo $hostPath  = '%JSON_PATH%'
  echo $existing  = Get-Content $manifest -Raw ^| ConvertFrom-Json
  echo $origins   = $existing.allowed_origins -join '","'
  echo $json = "{`n  `"name`": `"com.reamlet.chromebridge`",`n  `"description`": `"Reamlet native messaging host`",`n  `"path`": `"$hostPath`",`n  `"type`": `"stdio`",`n  `"allowed_origins`": [`n    `"$origins`"`n  ]`n}"
  echo [System.IO.File]::WriteAllText^($manifest, $json, [System.Text.Encoding]::UTF8^)
) > "%PS_FILE%"
powershell -ExecutionPolicy Bypass -NoProfile -File "%PS_FILE%"
del "%PS_FILE%" 2>nul

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
