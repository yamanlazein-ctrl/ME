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
# The phone variant: the 3-button navigation bar and a larger system font, as on many customers' phones.
NAV_MODE="${NAV_MODE:-}"; FONT_SCALE="${FONT_SCALE:-1.0}"
if [ -n "$NAV_MODE" ]; then
  adb shell cmd overlay enable-exclusive --category "com.android.internal.systemui.navbar.$NAV_MODE" ||
    adb shell cmd overlay enable "com.android.internal.systemui.navbar.$NAV_MODE"
  sleep 5
fi
adb shell settings put system font_scale "$FONT_SCALE"
echo "device: $(adb shell wm size | tr -d '\r') $(adb shell wm density | tr -d '\r') nav=${NAV_MODE:-none} font=$FONT_SCALE"
# Top edge (px) of the phone's navigation bar, empty when the phone has none.
nav_top() {
  adb shell dumpsys window | tr -d '\r' |
    grep -oE 'navigationBars[^}]*[Ff]rame=\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]' | head -1 |
    sed -E 's/.*[Ff]rame=\[[0-9]+,([0-9]+)\].*/\1/'
}
NAVTOP=$(nav_top)
echo "navigation bar top: ${NAVTOP:-none}"
if [ -n "$NAV_MODE" ] && [ -z "$NAVTOP" ]; then
  echo "expected a navigation bar but found none:"; adb shell dumpsys window | grep -i navigation | head -20
  exit 1
fi
LAYOUT_BAD=""
# Nothing of the app with text may reach into the navigation bar (the customer's phone hid the bottom of the app).
layout_check() {
  [ -z "$NAVTOP" ] && return 0
  adb shell uiautomator dump /sdcard/l.xml >/dev/null 2>&1 || return 0
  local HIT
  HIT=$(adb shell cat /sdcard/l.xml | grep -o '<node [^>]*>' | grep 'package="com.motard.erp"' |
    grep -E ' text="[^"]+"' |
    sed -E 's/.* text="([^"]*)".* bounds="\[[0-9]+,([0-9]+)\]\[[0-9]+,([0-9]+)\]".*/\2 \3 \1/' |
    awk -v n="$NAVTOP" '$2 > n + 1 {print}')
  if [ -n "$HIT" ]; then
    echo "--- $1: app text under the navigation bar (top=$NAVTOP) ---"; echo "$HIT" | head -10
    adb exec-out screencap -p > "$OUT/LAYOUT-$1.png" 2>/dev/null
    LAYOUT_BAD="$LAYOUT_BAD $1"
  fi
}
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
    if [ "${PIPESTATUS[0]}" -eq 0 ]; then PASSED=1; layout_check "$NAME"; break; fi
    echo "--- attempt $ATTEMPT of $NAME failed (junit) ---"; grep -E -A6 "<failure|<error" "$OUT/$NAME.xml" 2>/dev/null | head -20
    adb exec-out screencap -p > "$OUT/FAILED-$NAME-$ATTEMPT.png" 2>/dev/null
    # What the phone was showing when the flow failed (the screenshot is only in the artifact).
    # Each node's text, resource id and on-screen bounds, plus the screen size and whether the keyboard is up, so a
    # half-hidden control can be told apart from a missing one.
    echo "   screen size: $(adb shell wm size | tr -d '\r') · keyboard: $(adb shell dumpsys input_method | grep -o -m1 'mInputShown=[a-z]*')"
    adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 && adb shell cat /sdcard/ui.xml | grep -o '<node [^>]*>' |
      sed -E 's/.* text="([^"]*)" resource-id="([^"]*)".* bounds="([^"]*)".*/\1 | \2 | \3/' |
      grep -v '^ |  | ' | head -60 | sed 's/^/   screen: /'
    [ "$NAME" = "00-enroll-login-home" ] && adb shell pm clear com.motard.erp >/dev/null 2>&1
  done
  if [ "$PASSED" -ne 1 ]; then FAILED="$FAILED $NAME"; fi
  if [ "$NAME" = "00-enroll-login-home" ] && [ -n "$FAILED" ]; then echo "enrolment failed: later flows cannot run"; break; fi
done
FLOW=0; [ -n "$FAILED" ] && FLOW=1
[ -n "$LAYOUT_BAD" ] && FLOW=1
echo "=== failed flows:${FAILED:- none} ==="
echo "=== layout (text under the navigation bar):${LAYOUT_BAD:- none} ==="
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
