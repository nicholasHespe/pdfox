; Reamlet — custom NSIS installer script (build/installer.nsh)
; electron-builder auto-detects this file from buildResourcesDir.
; Handles: Windows Default Programs, native messaging host registration.

!ifndef BUILD_UNINSTALLER
  !include "StrFunc.nsh"
  ${StrRep}
!endif

; ----- Finish page ---------------------------------------------------------
; customFinishPage REPLACES the entire finish block (it's an !if/!else against
; MUI_PAGE_FINISH in assistedInstaller.nsh), so we must reproduce the standard
; "Launch Reamlet" checkbox and call !insertmacro MUI_PAGE_FINISH ourselves.
!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif

  !define MUI_FINISHPAGE_SHOWREADME ""
  !define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Set Reamlet as the default PDF viewer"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION SetAsDefaultPDF

  !insertmacro MUI_PAGE_FINISH
!macroend

; ----- Register on install --------------------------------------------------
!macro customInstall
  ; Windows Default Programs registration
  WriteRegStr HKCU "Software\nicholasHespe\Reamlet\Capabilities" "ApplicationName" "Reamlet"
  WriteRegStr HKCU "Software\nicholasHespe\Reamlet\Capabilities" "ApplicationDescription" "Lightweight PDF viewer"
  WriteRegStr HKCU "Software\nicholasHespe\Reamlet\Capabilities\FileAssociations" ".pdf" "PDF Document"
  WriteRegStr HKCU "Software\RegisteredApplications" "Reamlet" "Software\nicholasHespe\Reamlet\Capabilities"

  ; Native messaging host — write manifest with escaped path
  ${StrRep} $R0 "$INSTDIR\reamlet-native-host.exe" "\" "\\"
  FileOpen $0 "$INSTDIR\com.reamlet.chromebridge.json" w
  FileWrite $0 "{$\n"
  FileWrite $0 "  $\"name$\": $\"com.reamlet.chromebridge$\",$\n"
  FileWrite $0 "  $\"description$\": $\"Reamlet native messaging host$\",$\n"
  FileWrite $0 "  $\"path$\": $\"$R0$\",$\n"
  FileWrite $0 "  $\"type$\": $\"stdio$\",$\n"
  FileWrite $0 "  $\"allowed_origins$\": [$\n"
  FileWrite $0 "    $\"chrome-extension://PLACEHOLDER_CHROME_ID/$\"$\n"
  FileWrite $0 "  ]$\n"
  FileWrite $0 "}"
  FileClose $0

  ; Remove portable-only files that extraFiles bundles for both targets
  Delete "$INSTDIR\register-host.bat"
  Delete "$INSTDIR\unregister-host.bat"

  ; Register native messaging host for each supported Chromium browser
  WriteRegStr HKCU "Software\Google\Chrome\NativeMessagingHosts\com.reamlet.chromebridge"              "" "$INSTDIR\com.reamlet.chromebridge.json"
  WriteRegStr HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.reamlet.chromebridge"             "" "$INSTDIR\com.reamlet.chromebridge.json"
  WriteRegStr HKCU "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.reamlet.chromebridge" "" "$INSTDIR\com.reamlet.chromebridge.json"
  WriteRegStr HKCU "Software\Vivaldi\NativeMessagingHosts\com.reamlet.chromebridge"                    "" "$INSTDIR\com.reamlet.chromebridge.json"
  WriteRegStr HKCU "Software\Opera Software\Opera\NativeMessagingHosts\com.reamlet.chromebridge"       "" "$INSTDIR\com.reamlet.chromebridge.json"
  WriteRegStr HKCU "Software\Opera Software\Opera GX\NativeMessagingHosts\com.reamlet.chromebridge"   "" "$INSTDIR\com.reamlet.chromebridge.json"
!macroend

; ----- Clean up on uninstall -----------------------------------------------
!macro customUnInstall
  ; Kill any running Reamlet instances before files are removed
  ExecWait 'taskkill /F /IM "Reamlet.exe"'

  ; Windows Default Programs cleanup
  DeleteRegKey   HKCU "Software\nicholasHespe\Reamlet"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Reamlet"

  ; Native messaging host cleanup for all browsers
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.reamlet.chromebridge"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.reamlet.chromebridge"
  DeleteRegKey HKCU "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.reamlet.chromebridge"
  DeleteRegKey HKCU "Software\Vivaldi\NativeMessagingHosts\com.reamlet.chromebridge"
  DeleteRegKey HKCU "Software\Opera Software\Opera\NativeMessagingHosts\com.reamlet.chromebridge"
  DeleteRegKey HKCU "Software\Opera Software\Opera GX\NativeMessagingHosts\com.reamlet.chromebridge"
!macroend

; ----- Called when the "Set as default" checkbox is ticked on Finish page ---
!ifndef BUILD_UNINSTALLER
Function SetAsDefaultPDF
  WriteRegStr HKCU "Software\Classes\.pdf" "" "PDF Document"
  System::Call "shell32::SHChangeNotify(i 0x08000000, i 0x1000, i 0, i 0)"
FunctionEnd
!endif
