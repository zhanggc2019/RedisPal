Unicode true
RequestExecutionLevel user
ManifestDPIAware true
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

!ifndef APP_NAME
  !define APP_NAME "RedisPal"
!endif
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"
!define WEBVIEW2_KEY "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

Name "${APP_NAME}"
OutFile "${INSTALLER_PATH}"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"

VIProductVersion "${APP_FILE_VERSION}"
VIFileVersion "${APP_FILE_VERSION}"
VIAddVersionKey "ProductName" "RedisPal"
VIAddVersionKey "FileDescription" "RedisPal Windows x64 Setup"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "RedisPal contributors"

!define MUI_ICON "RedisPal.ico"
!define MUI_UNICON "RedisPal.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\RedisPal.exe"
!define MUI_FINISHPAGE_RUN_NOTCHECKED

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

LangString UnsupportedWindows ${LANG_SIMPCHINESE} "此安装包需要能够运行 x64 应用的 64 位 Windows。"
LangString UnsupportedWindows ${LANG_ENGLISH} "This installer requires 64-bit Windows with support for x64 apps."
LangString InstallingRuntime ${LANG_SIMPCHINESE} "正在安装 Microsoft Edge WebView2 Runtime…"
LangString InstallingRuntime ${LANG_ENGLISH} "Installing Microsoft Edge WebView2 Runtime…"
LangString RuntimeFailed ${LANG_SIMPCHINESE} "未能安装 WebView2 Runtime。请联网后重新运行安装程序。"
LangString RuntimeFailed ${LANG_ENGLISH} "WebView2 Runtime could not be installed. Connect to the internet and run setup again."
LangString InstallFailed ${LANG_SIMPCHINESE} "无法写入安装文件。请关闭 RedisPal，并确认安装目录可写后重试。"
LangString InstallFailed ${LANG_ENGLISH} "Could not write the installation files. Close RedisPal and check that the installation folder is writable."
LangString UninstallFailed ${LANG_SIMPCHINESE} "无法移除 RedisPal。请关闭程序后重新卸载。"
LangString UninstallFailed ${LANG_ENGLISH} "Could not remove RedisPal. Close the app and try uninstalling again."

; Select the installer language and reject 32-bit Windows before changing files.
Function .onInit
  SetShellVarContext current
  StrCpy $LANGUAGE ${LANG_SIMPCHINESE}
  !insertmacro MUI_LANGDLL_DISPLAY
  ${Unless} ${RunningX64}
    MessageBox MB_ICONSTOP|MB_OK "$(UnsupportedWindows)" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndUnless}
FunctionEnd

; Return a nonempty WebView2 version from either the machine or current user.
Function WebView2Version
  SetRegView 32
  ReadRegStr $0 HKLM "${WEBVIEW2_KEY}" "pv"
  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    ReadRegStr $0 HKCU "${WEBVIEW2_KEY}" "pv"
  ${EndIf}
  Push $0
FunctionEnd

; Install Microsoft's Evergreen runtime when Windows has no usable copy.
Function EnsureWebView2
  Call WebView2Version
  Pop $0
  ${If} $0 != ""
  ${AndIf} $0 != "0.0.0.0"
    Return
  ${EndIf}
  DetailPrint "$(InstallingRuntime)"
  InitPluginsDir
  File "/oname=$PLUGINSDIR\MicrosoftEdgeWebView2Setup.exe" "${WEBVIEW2_BOOTSTRAPPER}"
  ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebView2Setup.exe" /silent /install'
  Call WebView2Version
  Pop $0
  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    MessageBox MB_ICONSTOP|MB_OK "$(RuntimeFailed)" /SD IDOK
    SetErrorLevel 3
    Abort
  ${EndIf}
FunctionEnd

Section "RedisPal"
  Call EnsureWebView2
  ClearErrors
  SetOutPath "$INSTDIR"
  IfErrors install_failed
  SetOverwrite try
  File "/oname=RedisPal.exe" "${APP_EXE}"
  IfErrors install_failed
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  IfErrors install_failed
  CreateShortCut "$SMPROGRAMS\${APP_NAME}.lnk" "$INSTDIR\RedisPal.exe"
  IfErrors install_failed
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "RedisPal"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" '"$INSTDIR\RedisPal.exe",0'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  IfErrors install_failed
  Goto install_done

install_failed:
  MessageBox MB_ICONSTOP|MB_OK "$(InstallFailed)" /SD IDOK
  SetErrorLevel 4
  Abort
install_done:
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  SetOutPath "$TEMP"
  Delete "$INSTDIR\RedisPal.exe"
  ${If} ${FileExists} "$INSTDIR\RedisPal.exe"
    MessageBox MB_ICONSTOP|MB_OK "$(UninstallFailed)" /SD IDOK
    SetErrorLevel 4
    Abort
  ${EndIf}
  ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "InstallLocation"
  ${If} $0 == $INSTDIR
    Delete "$SMPROGRAMS\${APP_NAME}.lnk"
    DeleteRegKey HKCU "${UNINSTALL_KEY}"
  ${EndIf}
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
