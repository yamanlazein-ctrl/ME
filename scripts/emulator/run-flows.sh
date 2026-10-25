#!/usr/bin/env bash
# Runs inside the emulator (reactivecircus/android-emulator-runner): install the APK, run the Maestro flow against the
# test hub, then fail on crashes or MOTARD_ERR lines in the device log. Screenshots land in $OUT.
set -uo pipefail
APK="$1"; INFO="$2"; OUT="$3"
mkdir -p "$OUT"
field() { node -p "JSON.parse(require('fs').readFileSync('$INFO','utf8')).$1"; }
HUB=$(field hubForEmulator); CODE=$(field code); PIN=$(field pin)
OUT="$(pwd)/$OUT"; mkdir -p "$OUT"
adb wait-for-device
for i in $(seq 1 60); do [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = "1" ] && break; sleep 2; done
sleep 15 # let the emulator settle: Maestro hit "device offline" when it started right after boot
adb install -r "$APK"
adb logcat -c
set +e
# Each flow is its own Maestro run, so one broken screen does not hide the others. 00 must pass first (it enrols the phone);
# the rest start from a cold launch and the app-lock PIN.
FAILED=""
for FLOW_FILE in "$(pwd)"/mobile/e2e/[0-9][0-9]-*.yaml; do
  NAME=$(basename "$FLOW_FILE" .yaml)
  echo "##### $NAME"
  PASSED=0
  for ATTEMPT in 1 2; do # one retry: the emulator itself is occasionally flaky; a real bug fails both times
    (cd "$OUT" && maestro test --format junit --output "$OUT/$NAME.xml" --debug-output "$OUT/debug-$NAME" -e HUB="$HUB" -e CODE="$CODE" -e PIN="$PIN" "$FLOW_FILE") 2>&1 | tee "$OUT/$NAME.log"
    if [ "${PIPESTATUS[0]}" -eq 0 ]; then PASSED=1; break; fi
    echo "--- attempt $ATTEMPT of $NAME failed (junit) ---"; grep -E -A6 "<failure|<error" "$OUT/$NAME.xml" 2>/dev/null | head -20
    adb exec-out screencap -p > "$OUT/FAILED-$NAME-$ATTEMPT.png" 2>/dev/null
    [ "$NAME" = "00-enroll-login-home" ] && adb shell pm clear com.motard.erp >/dev/null 2>&1
  done
  if [ "$PASSED" -ne 1 ]; then FAILED="$FAILED $NAME"; fi
  if [ "$NAME" = "00-enroll-login-home" ] && [ -n "$FAILED" ]; then echo "enrolment failed: later flows cannot run"; break; fi
done
FLOW=0; [ -n "$FAILED" ] && FLOW=1
echo "=== failed flows:${FAILED:- none} ==="
set -e
adb logcat -d -v time > "$OUT/logcat.txt"
echo "=== MOTARD_ERR lines ==="; grep -E "MOTARD_ERR" "$OUT/logcat.txt" | head -50 || true
echo "=== crashes ==="; grep -E "FATAL EXCEPTION|Process: com.motard.erp|Fatal signal" "$OUT/logcat.txt" | head -20 || true
echo "=== fonts ==="; grep -E "is not a system font and has not been loaded" "$OUT/logcat.txt" | head -5 || true
BAD=0
if grep -qE "FATAL EXCEPTION|Fatal signal" "$OUT/logcat.txt"; then BAD=1; fi
if grep -q "MOTARD_ERR" "$OUT/logcat.txt"; then BAD=1; fi
if grep -q "is not a system font and has not been loaded" "$OUT/logcat.txt"; then BAD=1; fi
if [ "$FLOW" -ne 0 ] || [ "$BAD" -ne 0 ]; then echo "EMULATOR VERIFICATION FAILED (flow=$FLOW bad=$BAD)"; exit 1; fi
echo "EMULATOR VERIFICATION PASSED"
