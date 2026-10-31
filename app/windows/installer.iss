; LOCKqz Windows installer recipe (Inno Setup). Produces a double-click lockqz-win.exe.
; Build on Windows with Inno Setup's compiler:
;   ISCC.exe installer.iss                      (version from app\VERSION, API https://lockqz.pages.dev/api)
;   ISCC.exe /DLQAPI=https://<project>.pages.dev/api /DLQVER=X.Y.Z installer.iss   (overrides)
; (LQTOKEN is no longer needed: install.ps1 makes a fresh control token on each PC.)
; Sign the resulting Output\lockqz-win.exe in step 11 (Azure Artifact Signing), then put
; it at cloudflare/public/download/lockqz-win.exe.

#ifndef LQVER
  #define LQVERFILE FileOpen(AddBackslash(SourcePath) + "..\VERSION")
  #define LQVER Trim(FileRead(LQVERFILE))
  #expr FileClose(LQVERFILE)
#endif
#ifndef LQAPI
  #define LQAPI "https://lockqz.pages.dev/api"
#endif
#ifndef LQTOKEN
  #define LQTOKEN ""
#endif

[Setup]
AppName=LOCKqz
AppVersion={#LQVER}
DefaultDirName={commonappdata}\LOCKqz
DisableDirPage=yes
PrivilegesRequired=admin
OutputBaseFilename=lockqz-win
Uninstallable=yes

[Files]
Source: "lockqz.ps1";    DestDir: "{app}"; Flags: ignoreversion
Source: "lockqzd.ps1";   DestDir: "{app}"; Flags: ignoreversion
Source: "lockqz-boot.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "blocklist.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "browser-policy.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "lockqz-agent.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "install.ps1";   DestDir: "{app}"; Flags: ignoreversion
Source: "uninstall.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "update.pub.xml"; DestDir: "{app}"; Flags: ignoreversion

[Code]
// Run the setup script ourselves so a failure is NEVER silent: the student sees an error
// and the installer exits non-zero (instead of "success" with nothing protected).
var SetupFailed: Boolean;
procedure CurStepChanged(CurStep: TSetupStep);
var R: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    WizardForm.StatusLabel.Caption := 'Installing LOCKqz helper...';
    if (not Exec('powershell.exe',
         '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\install.ps1') +
         '" -Api "{#LQAPI}" -FromExe', '', SW_HIDE, ewWaitUntilTerminated, R)) or (R <> 0) then
    begin
      SetupFailed := True;
      SuppressibleMsgBox('LOCKqz could not finish setting up (code ' + IntToStr(R) + '). ' +
        'Please run the installer again. If it keeps failing, tell your professor.', mbError, MB_OK, IDOK);
    end;
  end;
end;
function GetCustomSetupExitCode: Integer;
begin
  if SetupFailed then Result := 1 else Result := 0;
end;

// Uninstall: run uninstall.ps1 FIRST and stop if it fails (the AI block or the student's own browser
// settings could not be restored). Nothing is removed then, so it can simply be run again; the
// student is told what to do instead of being shown "uninstalled" with AI still blocked.
function InitializeUninstall: Boolean;
var R: Integer;
begin
  Result := True;
  if (not Exec('powershell.exe',
       '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\uninstall.ps1') + '"',
       '', SW_HIDE, ewWaitUntilTerminated, R)) or (R <> 0) then
  begin
    SuppressibleMsgBox('LOCKqz could not finish removing itself (code ' + IntToStr(R) + '). ' +
      'Restart the computer, then remove LOCKqz again.', mbError, MB_OK, IDOK);
    Result := False;
  end;
end;
