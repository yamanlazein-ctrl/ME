# Work plan: remaining screens (owner request 2026-10-27)

Memory file. Updated after every step. A screen is "done" only when the emulator job passes its flow.

Order (tasks.md): P15 inventory -> P16 reports -> P17 purchase -> P18 returns -> P19 orders + close-day -> P20 PDF/WhatsApp -> P21 update check -> P22 opening balance -> P23 a11y/perf/release.

| Phase                                      | Status                                                             | Notes                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| P15 inventory, adjust, count (T107-T110)   | code + unit tests done; emulator flows 25, 86 written, awaiting CI | sync unit roll/adjust enqueued through enqueueRollAdjustment (same as desktop route) |
| P16 reports                                | todo                                                               |                                                                                      |
| P17 purchase entry                         | todo                                                               |                                                                                      |
| P18 returns                                | todo                                                               |                                                                                      |
| P19 orders + close-day                     | todo                                                               |                                                                                      |
| P20 PDF/WhatsApp                           | todo                                                               |                                                                                      |
| P21 update check (BC-5 backend route)      | todo                                                               |                                                                                      |
| P22 opening balance, revoke count          | todo                                                               |                                                                                      |
| P23 a11y test, perf test, release workflow | todo                                                               |                                                                                      |

Rules: GATE-M (mobile tsc/eslint/vitest/prettier) before every push; GATE-D if backend changes; never change desktop behaviour; each write goes through the shared use-case + the shared enqueue function in ONE transaction; no invented data.
