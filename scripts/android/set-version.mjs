// Gives every CI build of the phone app a higher Android version than the one before it, so a new APK installs OVER
// the installed one and keeps its data (Android refuses an APK whose versionCode is lower, and two builds with the same
// number cannot be told apart). versionCode = 100 + the workflow's run number (always increasing); the version shown
// to people is 1.1.<run>. Usage: node scripts/android/set-version.mjs mobile/app.json <run number>
import { readFileSync, writeFileSync } from "node:fs";

const [file, runArg] = process.argv.slice(2);
const run = Number(runArg);
if (!file || !Number.isInteger(run) || run <= 0) {
  console.error("usage: set-version.mjs <app.json> <positive run number>");
  process.exit(1);
}
const app = JSON.parse(readFileSync(file, "utf8"));
app.expo.version = `1.1.${run}`;
app.expo.android = { ...app.expo.android, versionCode: 100 + run };
writeFileSync(file, `${JSON.stringify(app, null, 2)}\n`);
console.log(`version ${app.expo.version} (versionCode ${app.expo.android.versionCode})`);
