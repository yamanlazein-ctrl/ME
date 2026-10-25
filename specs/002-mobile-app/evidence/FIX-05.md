# FIX-05 — real verification on an emulator (GitHub Actions, workflow `mobile-android`)

Job `apk`, after the Gradle build:
1. PostgreSQL in Docker (no fsync), then `scripts/emulator/start-test-hub.mjs`: a fresh clone of the AC-8 template database, the UNCHANGED
   backend as a hub on 0.0.0.0, a test licence, a PIN for the admin, 12 parties / 60 invoices / 60 receipts pushed as real sync units
   (`scripts/parity/seed-sync-volume.mjs`), an enrolment code.
2. Android 34 x86_64 emulator, the APK installed, then one Maestro run per flow (`mobile/e2e/*.yaml`, driven by
   `scripts/emulator/run-flows.sh`): 00 enrol + first download + PIN sign-in + Home; 10 sync status and fonts; 20 cashbox; 30 parties →
   party → statement; 40 receipt; 50 payment; 60 expense; 70 sale → roll picker → review → save → invoice detail; 80 Home after the writes.
   Every flow starts cold and passes the app-lock PIN. A flow fails on any missing element, any "تعذّر" text, any `*-error` element.
3. The script then fails the job on any `MOTARD_ERR` line, `FATAL EXCEPTION`, or font-not-loaded line in logcat.
4. Artifact `emulator-screenshots`: a screenshot per screen (`01-enroll` … `20-home-after`), per-flow junit and logs, the logcat, the hub log.
The workflow can also be started with `apk_run_id` to re-run only this verification on an earlier APK.

Result history is in the final report; a screen is only reported as working when its flow passed in this job.
