#!/usr/bin/env node
/**
 * Build a signed-updater latest.json skeleton.
 *
 * Usage:
 *   node desktop/scripts/write-latest-json.mjs \
 *     --version 1.0.1 \
 *     --url https://updates.example.com/Motard-ERP_1.0.1_x64-setup.exe \
 *     --signature "$(Get-Content -Raw .\nsis-setup.exe.sig)" \
 *     --out dist/latest.json
 *
 * The signature file is produced by `tauri build` when
 * bundle.createUpdaterArtifacts is true (minisign of the installer).
 * AppData/pgdata is outside the install directory; MSI/NSIS upgrades must
 * never pass MOTARD_WIPEDATA=1. Uninstall wipe stays opt-in via wix-cleanup.wxs.
 */
import { writeFileSync } from "node:fs";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? String(process.argv[i + 1] ?? fallback) : fallback;
}

const version = arg("version");
const url = arg("url");
const signature = arg("signature");
const notes = arg("notes", "تحديث Motard ERP — تُحفظ بيانات الشركة في AppData");
const out = arg("out", "latest.json");

if (!version || !url || !signature) {
  console.error("required: --version --url --signature [--notes] [--out]");
  process.exit(1);
}

const body = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": { signature, url },
  },
};

writeFileSync(out, `${JSON.stringify(body, null, 2)}\n`, "utf8");
console.log(`wrote ${out}`);
