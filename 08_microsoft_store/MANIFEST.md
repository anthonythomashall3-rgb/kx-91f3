# 08_microsoft_store - LOCKqz on the Microsoft Store (2026-10-24)
- STORE-LISTING.md - copy-paste text for every Partner Center page (listing, runFullTrust reason, certification notes)
- screenshot-1366x768.png - Store screenshot (real app window, captured on the CI Windows runner)
- StoreListing300.png - 1:1 300x300 logo
- lockqz-store.msix - added after the Partner Center identity is set (CI artifact "lockqz-store")
Code: app/windows/store (LOCKqz.cs launcher, AppxManifest.xml.in, build-msix.ps1). Test: app/tests/test_windows_store.ps1 (27/27 on CI run 40110900760).
- lockqz-store.msix - Store build (BrainChild.LOCKqz, CN=1A42620D-42A4-477F-9C34-30F2A815AE62, v0.3.0.0), CI run 40116067665. Uploaded + validated in Partner Center 2026-10-24.
Partner Center: Outlook account anthonythomashall31@outlook.com (NOT the USC one). Store ID 9P7D1114N2LJ. https://apps.microsoft.com/detail/9P7D1114N2LJ
