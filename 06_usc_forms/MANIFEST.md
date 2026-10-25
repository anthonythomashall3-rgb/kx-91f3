# MANIFEST — 06_usc_forms

Created 22 Oct 2026. Everything USC asks for to add LOCKqz to Brightspace (LTI), filled in. Nothing has been sent.

| File | What it is |
|---|---|
| LOCKqz - LTI Intake Form.pdf | USC's LTI Intake Form, filled. Requester: Professor Duke Bristow (Marshall, FBE). Vendor contact: Anthony Hall, athall@usc.edu, 858-900-4347. Semester: Fall 2026. Pricing: no cost for the pilot; long-term pricing not set. |
| LOCKqz - Security Questions for New LTI.pdf | USC's security questionnaire (attached by the Domain Admin to the ITS Application Add-On request), filled. |
| LOCKqz - VPAT 2.5 Accessibility Conformance Report.pdf / .docx | ITI VPAT 2.5Rev (WCAG edition), WCAG 2.0/2.1 A and AA. Based on axe-core 4.10.2 scans of the live site, keyboard, reflow and text-spacing checks. Known gaps: placeholder-only labels, status messages not announced, missing autocomplete, some low contrast. |
| LOCKqz - HECVAT 4.1.6.xlsx | EDUCAUSE HECVAT 4.1.6, every vendor tab answered (331 rows: 223 answered, 108 not applicable with reasons). Evaluation tabs left blank for USC. |
| reference/ | Blank originals: USC intake and security forms, HECVAT 4.1.6, and a text dump of all HECVAT questions. |
| _to_delete/ | Two LibreOffice temp files; safe to delete. |

## Send to
- To: Marc Choueiti, choueiti@usc.edu (Brightspace Domain Admin, Marshall FBE). Cc: Professor Duke Bristow, dbristow@usc.edu.
- Draft is in Anthony's USC Gmail (subject "LTI Intake Form: LOCKqz (FBE, Professor Bristow)"). Attach the four documents before sending.

## Open items before sending
- Fake-lock hole (a student could fake a lock and get the quiz password): fixed and live 23 Oct 2026, strict mode on (see 07_device_auth). HECVAT START HERE C27 updated to match.
- Privacy page fixed locally (contact email; name collected at setup). Not yet deployed.
- HECVAT PDAT-04 filled 23 Oct 2026: "No" (data stays in the US; Cloudflare D1 region WNAM / United States). DPAI-01..08 response cells set (No / N/A — LOCKqz does no AI processing; the N/A notes were already there). Edited with openpyxl, which drops Excel dropdown validation + conditional formatting (answers and all 17,748 formulas intact); pristine pre-edit copy kept as "LOCKqz - HECVAT 4.1.6.BEFORE_PDAT04.xlsx". Open once in Excel to confirm formatting before sending. HIPAA/PCI/AI-tab/datacenter modules remain N/A (do not apply to LOCKqz) — not fabricated.
- No SOC 2 (USC asks for one); hosting provider Cloudflare holds SOC 2 Type II.

## Sources
- USC New LTI Request Process: https://www.brightspacehelp.usc.edu/instructors/new-lti-request-process/
- USC DA new-LTI process: https://www.brightspacehelp.usc.edu/domain-admin-guides/da-net-new-lti-request-process/
- ITI VPAT: https://www.itic.org/policy/accessibility/vpat
- EDUCAUSE HECVAT: https://www.educause.edu/hecvat


2026-10-23: Final check — all 4 forms complete. HECVAT + VPAT URLs updated lockdownqz -> lockqz.pages.dev / prof.lockqz.pages.dev. Backups of VPAT pre-edit in /tmp/vp. Handoff: claude Project doc LOCKqz-HANDOFF.md.
