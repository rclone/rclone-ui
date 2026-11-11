; The Windows installer of Rclone UI. It installs per user (in %LOCALAPPDATA%\Programs) or per
; machine (in Program Files), and an upgrade keeps the mode and folder of the existing install.
;
; Built by build/package.sh:
;   makensis -DVERSION=4.0.0 -DFILEVERSION=4.0.0.0 -DARCH=x64|arm64
;            -DBINDIR=<build/bin/windows-…> -DOUTFILE=<…>
;            -DWEBVIEW2BOOTSTRAPPER=<MicrosoftEdgeWebview2Setup.exe> -DWINFSPMSI=<winfsp-….msi>
;            [-DSIGNCOMMAND=<cmd "%1">] project.nsi
;
; Switches (the updater passes /P /UPDATE /WAITPID=<pid> [/R]; WinGet /S):
;   /S          silent            /P        passive: a progress window, no questions
;   /UPDATE     no new shortcuts  /NS       no shortcuts at all
;   /WAITPID=n  wait for process n (the app that started the update) to exit first
;   /R          start the app when done (passive or silent)
;   /NOWINFSP   don't install WinFsp (see the WinFsp section)
;
; It exits with code 10 when a running copy keeps the files and the user (or /S) gives up. WinGet
; reads that code as packageInUse, so a silent upgrade says to close the app, and not that the
; install failed.

Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma

; CI builds with NSIS's strlen_8192 build (build.yml). A standard build still works, but its
; uninstaller leaves $INSTDIR\bin on a PATH longer than 1024 characters (see "Add rclone to PATH").
!if ${NSIS_MAX_STRLEN} < 8192
  !warning "NSIS_MAX_STRLEN is ${NSIS_MAX_STRLEN}: use NSIS's strlen_8192 build for releases"
!endif

!define PRODUCTNAME "Rclone UI"
!define MANUFACTURER "Rclone"
!define BUNDLEID "org.rclone.ui"
!define HOMEPAGE "https://github.com/rclone/rclone-ui"
!define MAINBINARY "rcui.exe"
; The Start menu's folder for the app's shortcut, named after the publisher.
!define STARTMENUDIR "$SMPROGRAMS\${MANUFACTURER}"
; The app's entry in Apps & features, and the key that keeps the install folder.
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${BUNDLEID}"
!define MANUKEY "Software\${MANUFACTURER}"
!define MANUPRODUCTKEY "${MANUKEY}\${PRODUCTNAME}"
!define WEBVIEW2APPGUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
; go-toast's notification activator class (GUID_ImplNotificationActivationCallback).
!define GOTOASTACTIVATOR "{0F82E845-CB89-4039-BDBF-67CA33254C76}"

!ifndef VERSION
  !error "-DVERSION=<x.y.z> is required"
!endif
!ifndef FILEVERSION
  !error "-DFILEVERSION=<x.y.z.0, the version's numbers without a pre-release suffix> is required"
!endif
!ifndef ARCH
  !error "-DARCH=x64|arm64 is required"
!endif
!ifndef BINDIR
  !error "-DBINDIR=<folder with rcui.exe and bin\rclone.exe> is required"
!endif
!ifndef OUTFILE
  !error "-DOUTFILE=<the installer to write> is required"
!endif
!ifndef WEBVIEW2BOOTSTRAPPER
  !error "-DWEBVIEW2BOOTSTRAPPER=<MicrosoftEdgeWebview2Setup.exe> is required"
!endif
!ifndef WINFSPMSI
  !error "-DWINFSPMSI=<the WinFsp installer> is required"
!endif

; "= 0": a signing command that fails fails the build, rather than leave the installer or its
; uninstaller unsigned.
!ifdef SIGNCOMMAND
  !finalize '${SIGNCOMMAND}' = 0
  !uninstfinalize '${SIGNCOMMAND}' = 0
!endif

Name "${PRODUCTNAME}"
OutFile "${OUTFILE}"
BrandingText "${PRODUCTNAME} ${VERSION}"
; Placeholder: MultiUser picks the folder (and RestorePreviousInstallLocation an existing one).
InstallDir "$LOCALAPPDATA\Programs\${MANUFACTURER}\${PRODUCTNAME}"

; These two need four numbers, which a pre-release's VERSION (4.0.0-beta.1) isn't. The text keys
; below keep the full VERSION.
VIProductVersion "${FILEVERSION}"
VIFileVersion "${FILEVERSION}"
VIAddVersionKey "CompanyName" "${MANUFACTURER}"
VIAddVersionKey "FileDescription" "${PRODUCTNAME} Installer"
VIAddVersionKey "ProductName" "${PRODUCTNAME}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "© ${MANUFACTURER}"

; Per user or per machine: the mode of an existing install by default.
!define MULTIUSER_MUI
!define MULTIUSER_EXECUTIONLEVEL Highest
!define MULTIUSER_INSTALLMODE_INSTDIR "${MANUFACTURER}\${PRODUCTNAME}"
!define MULTIUSER_INSTALLMODE_COMMANDLINE
!define MULTIUSER_USE_PROGRAMFILES64
!define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_KEY "${UNINSTKEY}"
!define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_VALUENAME "CurrentUser"
!define MULTIUSER_INSTALLMODE_FUNCTION RestorePreviousInstallLocation
!define MULTIUSER_INSTALLMODEPAGE_SHOWUSERNAME
!include MultiUser.nsh
!include MUI2.nsh
!include FileFunc.nsh
!include LogicLib.nsh
!include WordFunc.nsh
!include x64.nsh
!include WinMessages.nsh

; Selects the registry's 64-bit view, which the app reads (app/update). The installer is a 32-bit
; program, so without this a per-machine install's keys are read and written under WOW6432Node,
; where the app doesn't look. It must run before MultiUser reads the keys.
!macro REGVIEW_64
  ${If} ${RunningX64}
  ${OrIf} ${IsNativeARM64}
    SetRegView 64
  ${EndIf}
!macroend

Var PassiveMode
Var UpdateMode
Var NoShortcutMode

!define MUI_ICON "..\icon.ico"
!define MUI_UNICON "..\icon.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION RunApp
; WinFsp's license asks for its notice and a link wherever it is used, and the installer adds it.
!define MUI_WELCOMEPAGE_TEXT "Setup will install ${PRODUCTNAME} on this computer.$\r$\n$\r$\n${PRODUCTNAME} mounts remotes as drives with WinFsp - Windows File System Proxy, Copyright (C) Bill Zissimopoulos (https://github.com/winfsp/winfsp). Setup also installs WinFsp when this computer doesn't have it and you are an administrator.$\r$\n$\r$\n$_CLICK"

!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MULTIUSER_PAGE_INSTALLMODE
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Function SkipIfPassive
  ${IfThen} $PassiveMode = 1 ${|} Abort ${|}
FunctionEnd

; RestorePreviousInstallLocation keeps an existing install's folder (the default value of the
; product key).
Function RestorePreviousInstallLocation
  ReadRegStr $0 SHCTX "${MANUPRODUCTKEY}" ""
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${EndIf}
FunctionEnd

Function .onInit
  ; An update of a per-user install starts this installer with __COMPAT_LAYER=RunAsInvoker
  ; (app/update), so that it runs without a UAC prompt. The programs that it starts, such as the
  ; app when it's done, must not inherit that.
  System::Call 'kernel32::SetEnvironmentVariable(t "__COMPAT_LAYER", p 0)'
  ${GetParameters} $R9
  StrCpy $PassiveMode 0
  ${GetOptions} $R9 "/P" $R0
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}
  StrCpy $UpdateMode 0
  ${GetOptions} $R9 "/UPDATE" $R0
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
  StrCpy $NoShortcutMode 0
  ${GetOptions} $R9 "/NS" $R0
  ${IfNot} ${Errors}
    StrCpy $NoShortcutMode 1
  ${EndIf}

  !if "${ARCH}" == "arm64"
    ${IfNot} ${IsNativeARM64}
      MessageBox MB_ICONSTOP "This installer is for Windows on Arm. Download the x64 installer instead." /SD IDOK
      Quit
    ${EndIf}
  !endif

  !insertmacro REGVIEW_64
  !insertmacro MULTIUSER_INIT

  ; Wait for the app that started the update to exit, before its files are replaced.
  ${GetOptions} $R9 "/WAITPID=" $R0
  ${IfNot} ${Errors}
    System::Call 'kernel32::OpenProcess(i 0x00100000, i 0, i $R0) p .r1'
    ${If} $1 P<> 0
      System::Call 'kernel32::WaitForSingleObject(p r1, i 60000) i .r2'
      System::Call 'kernel32::CloseHandle(p r1)'
    ${EndIf}
  ${EndIf}
FunctionEnd

!define EXIT_IN_USE 10 ; WinGet's packageInUse (ExpectedReturnCodes in its manifest)

; WaitUnlocked waits for a running copy to let go of $0 (a file of the install folder), asking
; the user to quit it when it doesn't within a few seconds. Giving up exits with EXIT_IN_USE.
; Defined twice, as the installer's and the uninstaller's (whose functions are named un.*).
!macro WAIT_UNLOCKED UN
Function ${UN}WaitUnlocked
  IfFileExists "$0" 0 done
  StrCpy $1 0
  retry:
    ClearErrors
    FileOpen $2 "$0" a
    ${IfNot} ${Errors}
      FileClose $2
      Goto done
    ${EndIf}
    IntOp $1 $1 + 1
    ${If} $1 < 20
      Sleep 500
      Goto retry
    ${EndIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${PRODUCTNAME} is running. Quit it from its tray icon, then press Retry." /SD IDCANCEL IDRETRY again
    SetErrorLevel ${EXIT_IN_USE}
    Abort
  again:
    StrCpy $1 0
    Goto retry
  done:
FunctionEnd
!macroend
!insertmacro WAIT_UNLOCKED ""
!insertmacro WAIT_UNLOCKED "un."

Section WebView2
  ; WebView2 is on every supported Windows 11 and most Windows 10; the bootstrapper installs it
  ; where it isn't.
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${If} $0 == ""
    ReadRegStr $0 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
  ${If} $0 == ""
    ReadRegStr $0 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    DetailPrint "Installing WebView2..."
    SetOutPath "$PLUGINSDIR"
    File "/oname=MicrosoftEdgeWebview2Setup.exe" "${WEBVIEW2BOOTSTRAPPER}"
    ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe" /silent /install' $1
    ${If} $1 != 0
      MessageBox MB_ICONEXCLAMATION "WebView2 could not be installed (code $1). ${PRODUCTNAME} needs it to show its windows." /SD IDOK
    ${EndIf}
  ${EndIf}
SectionEnd

Section Install
  SetOutPath $INSTDIR

  StrCpy $0 "$INSTDIR\${MAINBINARY}"
  Call WaitUnlocked

  File "${BINDIR}\${MAINBINARY}"
  SetOutPath "$INSTDIR\bin"
  File "${BINDIR}\bin\rclone.exe"
  SetOutPath $INSTDIR
  ; The WinFsp section installs WinFsp from this file. When it doesn't, the Mount page offers to
  ; (core/mounts' WinFspInstaller).
  File "/oname=winfsp.msi" "${WINFSPMSI}"
  File "/oname=LICENSE.txt" "..\..\..\LICENSE"
  File "..\..\..\public\THIRD_PARTY_NOTICES.txt"

  ; rclone:// links (the app also registers them for the user at start).
  WriteRegStr SHCTX "Software\Classes\rclone" "" "URL:${BUNDLEID} protocol"
  WriteRegStr SHCTX "Software\Classes\rclone" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\rclone\DefaultIcon" "" '"$INSTDIR\${MAINBINARY}",0'
  WriteRegStr SHCTX "Software\Classes\rclone\shell\open\command" "" '"$INSTDIR\${MAINBINARY}" "%1"'

  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr SHCTX "${MANUPRODUCTKEY}" "" $INSTDIR
  WriteRegStr SHCTX "${UNINSTKEY}" $MultiUser.InstallMode 1
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayIcon" '"$INSTDIR\${MAINBINARY}"'
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr SHCTX "${UNINSTKEY}" "Publisher" "${MANUFACTURER}"
  WriteRegStr SHCTX "${UNINSTKEY}" "InstallLocation" '"$INSTDIR"'
  WriteRegStr SHCTX "${UNINSTKEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr SHCTX "${UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegStr SHCTX "${UNINSTKEY}" "URLInfoAbout" "${HOMEPAGE}"
  WriteRegStr SHCTX "${UNINSTKEY}" "HelpLink" "${HOMEPAGE}"
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD SHCTX "${UNINSTKEY}" "EstimatedSize" "$0"

  ; Shortcuts, made on a first install only. The Start menu's is in the publisher's folder, which
  ; is the app's own. Another program's shortcut is never replaced: a desktop shortcut with the
  ; same name stays as it is.
  ${If} $UpdateMode = 0
  ${AndIf} $NoShortcutMode = 0
    CreateDirectory "${STARTMENUDIR}"
    CreateShortcut "${STARTMENUDIR}\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARY}"
    ${IfNot} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
      CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARY}"
    ${EndIf}
  ${EndIf}

  ${If} $PassiveMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

; WinFsp mounts remotes as drives. When this computer doesn't have it, this section installs it
; from the copy in the install folder, with no questions: the welcome page says so. It is skipped
; on an update and with /NOWINFSP. WinFsp installs a driver, which needs administrator rights, so
; the section is also skipped when the installer doesn't run as an administrator. It asks for
; those rights where the user has them (MULTIUSER_EXECUTIONLEVEL Highest). When WinFsp isn't
; installed here, the Mount page offers to install it from the same copy, and Windows asks for an
; administrator then. The uninstaller leaves WinFsp, which other programs may use.
Section WinFsp
  ${If} $UpdateMode = 1
    Return
  ${EndIf}
  ${GetParameters} $R9
  ${GetOptions} $R9 "/NOWINFSP" $R0
  ${IfNot} ${Errors}
    Return
  ${EndIf}
  ; WinFsp's key is in the registry's 32-bit view, which the 64-bit view (REGVIEW_64) reaches
  ; through WOW6432Node.
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\WinFsp" "InstallDir"
  ${If} $0 != ""
    Return
  ${EndIf}
  System::Call 'shell32::IsUserAnAdmin() i .r0'
  ${If} $0 = 0
    Return
  ${EndIf}
  DetailPrint "Installing WinFsp..."
  ClearErrors
  ExecWait '"$SYSDIR\msiexec.exe" /i "$INSTDIR\winfsp.msi" /qn /norestart' $1
  ${If} ${Errors} ; msiexec didn't start
    DetailPrint "WinFsp could not be installed. The Mount page offers to install it."
  ${ElseIf} $1 <> 0
  ${AndIf} $1 <> 3010 ; installed, and Windows wants a restart
    DetailPrint "WinFsp could not be installed (code $1). The Mount page offers to install it."
  ${EndIf}
SectionEnd

; RunApp starts the app as the user who installed it, without administrator rights. When this
; installer runs elevated, it starts the app through Explorer, which runs as the user. That is the
; case for a per-machine install, and also for a per-user install by an administrator, because the
; installer asks for the highest rights the user has (MULTIUSER_EXECUTIONLEVEL Highest).
Function RunApp
  System::Call 'shell32::IsUserAnAdmin() i .r0'
  ${If} $0 <> 0
    Exec '"$WINDIR\explorer.exe" "$INSTDIR\${MAINBINARY}"'
  ${Else}
    Exec '"$INSTDIR\${MAINBINARY}"'
  ${EndIf}
FunctionEnd

Function .onInstSuccess
  ; The finish page offers it in a normal install; /R asks for it in a passive or silent one.
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    ${GetParameters} $R9
    ${GetOptions} $R9 "/R" $R0
    ${IfNot} ${Errors}
      Call RunApp
    ${EndIf}
  ${EndIf}
FunctionEnd

Function un.onInit
  !insertmacro REGVIEW_64
  !insertmacro MULTIUSER_UNINIT
FunctionEnd

; un.DeleteOwnShortcut deletes the shortcut $0 when it opens this install's executable, and leaves
; another program's shortcut of the same name alone. It reads the shortcut's target through
; Windows' IShellLink: CoCreateInstance, IPersistFile::Load, then IShellLinkW::GetPath.
!define CLSID_ShellLink "{00021401-0000-0000-C000-000000000046}"
!define IID_IShellLinkW "{000214F9-0000-0000-C000-000000000046}"
!define IID_IPersistFile "{0000010B-0000-0000-C000-000000000046}"
Function un.DeleteOwnShortcut
  IfFileExists "$0" 0 done
  StrCpy $3 ""
  System::Call 'ole32::CoInitialize(p 0)'
  System::Call 'ole32::CoCreateInstance(g "${CLSID_ShellLink}", p 0, i 1, g "${IID_IShellLinkW}", *p .r1) i .r2'
  ${If} $2 = 0
    System::Call '$1->0(g "${IID_IPersistFile}", *p .r4) i .r2' ; QueryInterface
    ${If} $2 = 0
      System::Call '$4->5(w r0, i 0) i .r2' ; IPersistFile::Load
      ${If} $2 = 0
        System::Call '$1->3(w .r3, i ${NSIS_MAX_STRLEN}, p 0, i 0) i .r2' ; IShellLinkW::GetPath
      ${EndIf}
      System::Call '$4->2()' ; Release
    ${EndIf}
    System::Call '$1->2()' ; Release
  ${EndIf}
  ${If} $3 == "$INSTDIR\${MAINBINARY}"
    Delete "$0"
  ${EndIf}
  done:
FunctionEnd

Section Uninstall
  StrCpy $0 "$INSTDIR\${MAINBINARY}"
  Call un.WaitUnlocked

  StrCpy $0 "${STARTMENUDIR}\${PRODUCTNAME}.lnk"
  Call un.DeleteOwnShortcut
  RMDir "${STARTMENUDIR}"
  StrCpy $0 "$DESKTOP\${PRODUCTNAME}.lnk"
  Call un.DeleteOwnShortcut

  Delete "$INSTDIR\${MAINBINARY}"
  Delete "$INSTDIR\bin\rclone.exe"
  RMDir "$INSTDIR\bin"
  Delete "$INSTDIR\winfsp.msi"
  Delete "$INSTDIR\LICENSE.txt"
  Delete "$INSTDIR\THIRD_PARTY_NOTICES.txt"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  ; The publisher's folder that holds the install folder, when nothing else is in it. A folder
  ; that the user chose has another name and stays.
  ${GetParent} "$INSTDIR" $1
  ${GetFileName} "$1" $2
  ${If} $2 == "${MANUFACTURER}"
    RMDir "$1"
  ${EndIf}

  ; Remove the notifications' registration, which the app writes for the user at every start
  ; (Wails' notification service and go-toast), but only when it opens this install. Another copy
  ; of the app writes its own again when it starts. go-toast's activator class is shared by every
  ; program that uses go-toast, so it is also removed only when it opens this install.
  ReadRegStr $1 HKCU "Software\Classes\AppUserModelId\${PRODUCTNAME}" "CustomActivator"
  ${If} $1 != ""
    ReadRegStr $2 HKCU "Software\Classes\CLSID\$1\LocalServer32" ""
    ${If} $2 == '"$INSTDIR\${MAINBINARY}" %1'
      DeleteRegKey HKCU "Software\Classes\CLSID\$1"
      DeleteRegKey HKCU "Software\Classes\AppUserModelId\${PRODUCTNAME}"
    ${EndIf}
  ${EndIf}
  ReadRegStr $2 HKCU "Software\Classes\CLSID\${GOTOASTACTIVATOR}\LocalServer32" ""
  ${If} $2 == "$INSTDIR\${MAINBINARY}"
    DeleteRegKey HKCU "Software\Classes\CLSID\${GOTOASTACTIVATOR}"
  ${EndIf}

  ; rclone:// when it's this install's.
  ReadRegStr $1 SHCTX "Software\Classes\rclone\shell\open\command" ""
  ${If} $1 == '"$INSTDIR\${MAINBINARY}" "%1"'
    DeleteRegKey SHCTX "Software\Classes\rclone"
  ${EndIf}
  ; The per-user one the app writes at every start (deeplink.Register), which a per-machine
  ; uninstall would leave pointing at nothing.
  ReadRegStr $1 HKCU "Software\Classes\rclone\shell\open\command" ""
  ${If} $1 == '"$INSTDIR\${MAINBINARY}" "%1"'
    DeleteRegKey HKCU "Software\Classes\rclone"
  ${EndIf}

  ; "Add rclone to PATH" put $INSTDIR\bin on the user's PATH. ReadRegStr reads a PATH longer than
  ; NSIS_MAX_STRLEN as empty. CI makes the installer with NSIS's strlen_8192 build (build.yml), so
  ; that limit is 8192 characters, not the standard build's 1024. A longer PATH is left as it is,
  ; with $INSTDIR\bin in it, rather than written back cut short.
  ReadRegStr $1 HKCU "Environment" "Path"
  ${If} $1 != ""
    StrCpy $2 $1
    ${WordReplace} "$2" ";$INSTDIR\bin" "" "+" $2
    ${WordReplace} "$2" "$INSTDIR\bin;" "" "+" $2
    ${If} $2 == "$INSTDIR\bin"
      StrCpy $2 ""
    ${EndIf}
    ${If} $2 != $1
      WriteRegExpandStr HKCU "Environment" "Path" $2
      SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
    ${EndIf}
  ${EndIf}

  ; Starting at login (app/autostart).
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${BUNDLEID}"

  DeleteRegKey SHCTX "${UNINSTKEY}"
  DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
  DeleteRegKey /ifempty SHCTX "${MANUKEY}"
SectionEnd
