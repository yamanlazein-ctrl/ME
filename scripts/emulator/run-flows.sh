#!/usr/bin/env bash
# Runs inside the emulator (reactivecircus/android-emulator-runner): install the APK, run the Maestro flow against the
# test hub, then fail on crashes or MOTARD_ERR lines in the device log. Screenshots land in $OUT.
set -uo pipefail
APK="$1"; INFO="$2"; OUT="$3"
mkdir -p "$OUT"
field() { node -p "JSON.parse(require('fs').readFileSync('$INFO','utf8')).$1"; }
HUB=$(field hubForEmulator); CODE=$(field code); PIN=$(field pin)
FLOW_FILE="$(pwd)/mobile/e2e/full.yaml"
OUT="$(pwd)/$OUT"; mkdir -p "$OUT"
adb install -r "$APK"
adb logcat -c
set +e
# takeScreenshot writes into the working directory, so run from $OUT.
(cd "$OUT" && maestro test --format junit --output "$OUT/junit.xml" --debug-output "$OUT/debug" -e HUB="$HUB" -e CODE="$CODE" -e PIN="$PIN" "$FLOW_FILE") 2>&1 | tee "$OUT/maestro.log"
FLOW=${PIPESTATUS[0]}
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
