!macro NSIS_HOOK_PREINSTALL
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /F /T /IM "dsh-desktop.exe"'
  Pop $0
  Sleep 750
!macroend

!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$DESKTOP\ClawMaster.lnk" 0 icon_refresh_done
  Delete "$DESKTOP\ClawMaster.lnk"
  CreateShortCut "$DESKTOP\ClawMaster.lnk" "$INSTDIR\dsh-desktop.exe" "" "$INSTDIR\clawmaster-icon-0.2.0-beta.3.ico" 0 SW_SHOWNORMAL

icon_refresh_done:
  ; Explorer caches icons by shortcut and executable path, so notify it after
  ; replacing the shortcut with the versioned standalone icon resource.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
