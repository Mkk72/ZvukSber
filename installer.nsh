; Ярлыки создаём с --no-sandbox: на этой машине Chromium-песочница Electron
; не поднимается и приложение падает до выполнения кода (см. NOTES-spike.md).
; На машине, где песочница работает, аргумент можно убрать из обоих CreateShortCut.

!macro customInstall
  CreateShortCut "$DESKTOP\ZvukSber.lnk" "$INSTDIR\ZvukSber.exe" "--no-sandbox" "$INSTDIR\ZvukSber.exe" 0
  CreateShortCut "$SMPROGRAMS\ZvukSber.lnk" "$INSTDIR\ZvukSber.exe" "--no-sandbox" "$INSTDIR\ZvukSber.exe" 0
!macroend
