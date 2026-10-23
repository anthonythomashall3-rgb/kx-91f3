; LOCKqz Windows installer recipe (Inno Setup). Produces a double-click lockqz-win.exe.
; Build on Windows with Inno Setup's compiler, baking the deployment token + API:
;   ISCC.exe /DLQTOKEN=<shared-token> /DLQAPI=https://<project>.pages.dev/api installer.iss
; Sign the resulting Output\lockqz-win.exe in step 11 (Azure Artifact Signing), then put
; it at cloudflare/public/download/lockqz-win.exe.

[Setup]
AppName=LOCKqz
AppVersion=0.1.0
DefaultDirName={commonappdata}\LOCKqz
DisableDirPage=yes
PrivilegesRequired=admin
OutputBaseFilename=lockqz-win
Uninstallable=yes

[Files]
Source: "lockqz.ps1";    DestDir: "{app}"; Flags: ignoreversion
Source: "lockqzd.ps1";   DestDir: "{app}"; Flags: ignoreversion
Source: "blocklist.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "browser-policy.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "lockqz-agent.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "install.ps1";   DestDir: "{app}"; Flags: ignoreversion
Source: "uninstall.ps1"; DestDir: "{app}"; Flags: ignoreversion

[UninstallRun]
Filename: "powershell.exe"; \
  Parameters: "-WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\uninstall.ps1"""; \
  Flags: runhidden waituntilterminated; RunOnceId: "LOCKqzUninstall"

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
         '" -Token "{#LQTOKEN}" -Api "{#LQAPI}"', '', SW_HIDE, ewWaitUntilTerminated, R)) or (R <> 0) then
    begin
      SetupFailed := True;
      SuppressibleMsgBox('LOCKqz could not finish setting up (code ' + IntToStr(R) + '). ' +
        'Please run the installer again. If it keeps failing, tell your teacher.', mbError, MB_OK, IDOK);
    end;
  end;
end;
function GetCustomSetupExitCode: Integer;
begin
  if SetupFailed then Result := 1 else Result := 0;
end;
