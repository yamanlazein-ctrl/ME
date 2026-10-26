# Work plan: QR enrolment fix + full screen audit (owner request, 2026-10-26)

Rule: this file is the memory. Update the status column after every step. Nothing is marked done without a passing emulator run or a test.

## Owner request

1. The QR scan screen does not behave like a normal QR app (no frame, no cancel, no feedback).
2. Walk through EVERY screen / button / link on a test server and prove it works 100%.
3. Return to the login/enrol interface and verify it too.
4. Deliverable to the customer: nothing guessed, nothing faked.

## Findings (facts, verified in code)

- F1: the desktop (HubDevicesCard.tsx) shows only a TEXT code. No QR is ever generated, so the phone's scanner has nothing to scan. The phone expects JSON {"hub","code"} (enrollFlow.parseEnrollQr).
- F2: the phone scan view (app/enroll.tsx) is a bare camera: no frame, no hint, no cancel button, no permission-denied message, ignores unreadable codes silently.
- F3: hub address is available on desktop as hubSync.state().url.

## Steps

| #   | Step                                                                                                                                                         | Status                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| 1   | Desktop: show QR of {hub, code} next to the text code (additive, desktop behaviour unchanged)                                                                | done (code, desktop tsc+eslint ok) |
| 2   | Phone: scan overlay (frame, hint, cancel), permission-denied text, accepts JSON and motard://enroll?hub=&code= and plain "hub                                | code"; bad code -> message         | done (unit tests ok), emulator flow 00 covers scanner, wrong code, bad hub |
| 3   | Test hub reachable from CI only. Real-phone demo cannot reach it, so NO fake in-app bypass in the customer build. Instead: emulator flows cover every screen | decision                           |
| 4   | Emulator: add flows for scanner screen (cancel works, permission text), enrol typed, wrong code error, wrong hub error, back to login after wipe             | todo                               |
| 5   | Emulator: invoice detail (cancel, share PDF), every tab, every button on Home/More/Parties/Add/Inventory                                                     | todo                               |
| 6   | Screen checklist file with each screen + button + result                                                                                                     | todo                               |
| 7   | GATE-M / GATE-D / GATE-P, commit+push each step                                                                                                              | todo                               |
| 8   | Final Arabic report, honest list of what is not covered                                                                                                      | todo                               |

## Decisions

- D1: no "skip enrolment" bypass in the app. It would show invented data to a customer and break the S1/S2 rules (no guessing). The test hub in CI plays the "fake server" role with real seeded data.

## Result log

- Run 40398695326 (emulator): flows 00 (scanner open+cancel, unreachable hub text, wrong code text, real enrol), 10, 15 (tabs, Add menu, More rows, theme toggle), 20, 30, 40, 50, 60, 70 (sale, share PDF, cancel invoice), 80, 90 (logout -> login -> sign in) PASSED.
- 85 (new customer) FAILED, and exposed a real defect: a duplicate party name on the phone showed the generic "unexpected error" text because op-sqlite errors carry no SQLITE_* code, so the desktop error mapper did not recognise them. Fixed in BetterSqliteShim (withSqliteCode, unit tested). Flow 85 now also asserts the duplicate-name text.
- Still not delivered: Inventory tab is a "قريباً" placeholder; tasks T107+.
- Run 40406104578: only 85 failed. Cause is the flow, not the app: after typing the name the phone field did not get focus, so the phone digits were typed INTO the name field ("Zed 24750230555000111"); the second save was then a different name, so no duplicate. Fix: hideKeyboard between fields (same as flow 60). Added unit test test/unit/partyDuplicate.test.ts (duplicate name -> friendly text).

## GREEN: run 40412336509

Every emulator flow passed (00 scanner/wrong code/bad hub/enrol, 10, 15, 20, 30, 40, 50, 60, 70 incl. share PDF + cancel invoice, 80, 85 new customer + duplicate-name text + search, 90 logout/login). No crash, no MOTARD_ERR, no font errors.
Screenshots: https://github.com/yamanlazein-ctrl/ME/actions/runs/40412336509/artifacts/12694933210
APK: https://github.com/yamanlazein-ctrl/ME/actions/runs/40412336509/artifacts/12695096385
Not covered: Inventory is a "coming soon" placeholder; reports, purchase, returns, orders, PDF/WhatsApp (T107+) not built; real camera scan of the desktop QR not tested on the emulator (needs a real phone).
