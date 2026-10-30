// Adds the release signing config to the Expo-generated Android project (T133, FR-42). The keystore path and passwords
// come from the environment, so no secret is ever written into a file of the repository.
//   MOTARD_KEYSTORE_PATH, MOTARD_UPLOAD_KEYSTORE_PASSWORD, MOTARD_UPLOAD_KEY_ALIAS, MOTARD_UPLOAD_KEY_PASSWORD
import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node add-release-signing.mjs <android/app/build.gradle>");
  process.exit(2);
}
for (const name of [
  "MOTARD_KEYSTORE_PATH",
  "MOTARD_UPLOAD_KEYSTORE_PASSWORD",
  "MOTARD_UPLOAD_KEY_ALIAS",
  "MOTARD_UPLOAD_KEY_PASSWORD",
]) {
  if (!process.env[name]) {
    console.error(`missing ${name}`);
    process.exit(2);
  }
}
const src = readFileSync(file, "utf8");
if (src.includes("MOTARD_RELEASE_SIGNING")) {
  console.log("already configured");
  process.exit(0);
}
const block = `
// MOTARD_RELEASE_SIGNING: added by scripts/android/add-release-signing.mjs; values come from the environment.
android {
    signingConfigs {
        motardRelease {
            storeFile file(System.getenv("MOTARD_KEYSTORE_PATH"))
            storePassword System.getenv("MOTARD_UPLOAD_KEYSTORE_PASSWORD")
            keyAlias System.getenv("MOTARD_UPLOAD_KEY_ALIAS")
            keyPassword System.getenv("MOTARD_UPLOAD_KEY_PASSWORD")
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.motardRelease
        }
    }
}
`;
writeFileSync(file, src + block);
console.log("release signing added");
