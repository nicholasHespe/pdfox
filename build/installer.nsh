; ── Reamlet: set-as-default PDF viewer support ────────────────────────────
; Adds a "Set Reamlet as the default PDF viewer" checkbox to the Finish page,
; registers app capabilities with Windows, and cleans up on uninstall.

; The ProgID "PDF Document" matches the name field in package.json fileAssociations,
; which is what electron-builder passes to APP_ASSOCIATE as the FILECLASS.

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

; ----- Register with Windows Default Programs on install ------------------
!macro customInstall
  WriteRegStr HKCU "Software\nicholasHespe\Reamlet\Capabilities" "ApplicationName" "Reamlet"
  WriteRegStr HKCU "Software\nicholasHespe\Reamlet\Capabilities" "ApplicationDescription" "Lightweight PDF viewer"
  WriteRegStr HKCU "Software\nicholasHespe\Reamlet\Capabilities\FileAssociations" ".pdf" "PDF Document"
  WriteRegStr HKCU "Software\RegisteredApplications" "Reamlet" "Software\nicholasHespe\Reamlet\Capabilities"
!macroend

; ----- Clean up capabilities registration on uninstall -------------------
!macro customUnInstall
  DeleteRegKey   HKCU "Software\nicholasHespe\Reamlet"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Reamlet"
!macroend

; ----- Called when the checkbox is ticked and Finish is clicked -----------
; Guard against the uninstaller-only build pass where the function would be
; unreferenced and NSIS would promote the warning to a fatal error.
!ifndef BUILD_UNINSTALLER
Function SetAsDefaultPDF
  WriteRegStr HKCU "Software\Classes\.pdf" "" "PDF Document"
  System::Call "shell32::SHChangeNotify(i 0x08000000, i 0x1000, i 0, i 0)"
FunctionEnd
!endif
