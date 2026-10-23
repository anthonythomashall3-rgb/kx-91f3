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

[Run]
Filename: "powershell.exe"; \
  Parameters: "-WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\install.ps1"" -Token ""{#LQTOKEN}"" -Api ""{#LQAPI}"""; \
  StatusMsg: "Installing LOCKqz helper..."; Flags: runhidden waituntilterminated

[UninstallRun]
Filename: "powershell.exe"; \
  Parameters: "-WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\uninstall.ps1"""; \
  Flags: runhidden waituntilterminated
