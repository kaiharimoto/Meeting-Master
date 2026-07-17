; Inno Setup script — packages the PyInstaller onedir output into
;   MeetingMaster-HomeServer-Setup.exe
;
; BUILD (on Windows, in CI, after PyInstaller has produced dist\MeetingMasterServer):
;   iscc /DMyAppVersion=1.2.3 meeting-master-server.iss
;
; Installs per-user (no admin) to %LOCALAPPDATA%\Programs\MeetingMaster, adds a
; Start Menu shortcut and a per-user Startup shortcut so the server launches at
; login and sits in the system tray. The output .exe lands in .\Output.

; Version comes from CI via /DMyAppVersion=...; default keeps a manual build working.
#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif

#define MyAppName "Meeting Master Home Server"
#define MyAppExeName "MeetingMasterServer.exe"
#define MyAppPublisher "Meeting Master"

[Setup]
; Fixed AppId (GUID) so upgrades/uninstalls target the same app across versions.
AppId={{9C4F3B62-6D8E-4C2A-9E1B-2F7A5D0A3E44}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
VersionInfoVersion={#MyAppVersion}

; No-admin, per-user install.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DefaultDirName={localappdata}\Programs\MeetingMaster
DisableProgramGroupPage=yes
DefaultGroupName={#MyAppName}

OutputDir=Output
OutputBaseFilename=MeetingMaster-HomeServer-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
; Auto-start at login is opt-out (checked by default) — that is the point of a
; home server. It launches minimized to the tray.
Name: "startup"; Description: "Start Meeting Master Home Server automatically at sign-in"; GroupDescription: "Startup:"

[Files]
; The entire PyInstaller onedir bundle.
Source: "dist\MeetingMasterServer\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
; Start Menu shortcut.
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
; Per-user Startup shortcut (auto-start at login), created only if the task is selected.
Name: "{userstartup}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: startup

[Run]
; Offer to launch right after install (the app opens the setup page on first run).
Filename: "{app}\{#MyAppExeName}"; Description: "Launch Meeting Master Home Server now"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Leave user data (%APPDATA%\MeetingMaster) intact on uninstall; only remove the
; program folder, which Inno handles automatically for [Files] above.
Type: filesandordirs; Name: "{app}\__pycache__"
