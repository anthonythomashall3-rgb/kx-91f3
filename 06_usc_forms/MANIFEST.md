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
- Fake-lock hole (a student could fake a lock and get the quiz password): fixed in code and tested 23 Oct 2026, see 07_device_auth. Before sending: roll the fix out, then update HECVAT START HERE C27 with the text in 07_device_auth/DEVICE-AUTH.md.
- Privacy page fixed locally (contact email; name collected at setup). Not yet deployed.
- HECVAT PDAT-04 left blank: confirm the Cloudflare D1 database region.
- No SOC 2 (USC asks for one); hosting provider Cloudflare holds SOC 2 Type II.

## Sources
- USC New LTI Request Process: https://www.brightspacehelp.usc.edu/instructors/new-lti-request-process/
- USC DA new-LTI process: https://www.brightspacehelp.usc.edu/domain-admin-guides/da-net-new-lti-request-process/
- ITI VPAT: https://www.itic.org/policy/accessibility/vpat
- EDUCAUSE HECVAT: https://www.educause.edu/hecvat
