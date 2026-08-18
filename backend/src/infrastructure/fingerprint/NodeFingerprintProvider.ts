import { createHash } from "node:crypto";
import { hostname, networkInterfaces, cpus, platform, release } from "node:os";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  IMachineFingerprintProvider,
  FingerprintInput,
  FingerprintMetadata,
} from "../../application/ports/IMachineFingerprintProvider.js";

const execFileP = promisify(execFile);

/**
 * Phase 0 sub-batch 0D — Node-side machine fingerprint.
 *
 * Signals collected (deterministic, stable across reboots):
 *  - hostname                       (os.hostname)
 *  - primary_mac                    (first non-internal, non-zero MAC)
 *  - machine_id                     (/etc/machine-id on Linux,
 *                                   System\CurrentControlSet\...\MachineId
 *                                   on Windows via reg.exe, IOPlatformUUID
 *                                   on macOS via ioreg)
 *  - cpu_model                      (first CPU model string)
 *  - platform_release               (os.platform + os.release, e.g.
 *                                   "linux 5.15.0-91-generic")
 *
 * The fingerprint is a SHA-256 hex of the JSON-serialised signals in
 * a fixed key order. Changing the order or the algorithm version
 * invalidates existing fingerprints; bump `VERSION` on intentional
 * change.
 */
const VERSION = 1;

async function readLinuxMachineId(): Promise<string | null> {
  try {
    const raw = await readFile("/etc/machine-id", "utf8");
    return raw.trim();
  } catch {
    return null;
  }
}

async function readWindowsMachineId(): Promise<string | null> {
  try {
    const { stdout } = await execFileP("reg.exe", [
      "query",
      "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
      "/v",
      "MachineGuid",
    ]);
    const m = stdout.match(/MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function readMacOsMachineId(): Promise<string | null> {
  try {
    const { stdout } = await execFileP("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
    const m = stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function primaryMacAddress(): string | null {
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const i of list) {
      // Skip internal (loopback) and zero MACs.
      if (i.internal) continue;
      if (i.mac === "00:00:00:00:00:00") continue;
      return i.mac;
    }
  }
  return null;
}

export class NodeFingerprintProvider implements IMachineFingerprintProvider {
  async collect(): Promise<FingerprintInput> {
    const signals: Record<string, string> = {};
    signals.hostname = hostname();

    const mac = primaryMacAddress();
    if (mac) signals.primary_mac = mac;

    const cpu = cpus()[0]?.model ?? "";
    if (cpu) signals.cpu_model = cpu;

    signals.platform_release = `${platform()} ${release()}`;

    // Platform-specific machine id.
    if (platform() === "linux") {
      const id = await readLinuxMachineId();
      if (id) signals.machine_id = id;
    } else if (platform() === "win32") {
      const id = await readWindowsMachineId();
      if (id) signals.machine_id = id;
    } else if (platform() === "darwin") {
      const id = await readMacOsMachineId();
      if (id) signals.machine_id = id;
    }

    return { signals, platform: "node", version: VERSION };
  }

  async compute(input: FingerprintInput): Promise<string> {
    // Deterministic JSON serialisation: sort keys, no whitespace.
    const keys = Object.keys(input.signals).sort();
    const ordered: Record<string, string> = {};
    for (const k of keys) ordered[k] = input.signals[k]!;
    const payload = JSON.stringify({
      platform: input.platform,
      version: input.version,
      signals: ordered,
    });
    return createHash("sha256").update(payload).digest("hex");
  }

  async getMetadata(input: FingerprintInput): Promise<FingerprintMetadata> {
    const hash = await this.compute(input);
    const presentSignals = Object.keys(input.signals);
    // Confidence: high if machine_id + primary_mac are present, medium
    // if hostname only, low otherwise. machine_id is the most stable
    // signal across reboots; primary_mac is stable but can change on
    // hardware swap.
    let confidence: FingerprintMetadata["confidence"] = "low";
    if (input.signals.machine_id && input.signals.primary_mac) confidence = "high";
    else if (input.signals.machine_id || input.signals.primary_mac) confidence = "medium";

    return {
      hash,
      version: input.version,
      platform: input.platform,
      signals: presentSignals,
      confidence,
    };
  }
}

/**
 * Stub provider for Tauri desktop. The Tauri runtime exposes its own
 * signal-gathering primitives (e.g. `tauri::api::path::home_dir` and
 * the `tauri-plugin-machine-id` crate). Phase 0 only defines the
 * interface; the real implementation lands in Phase 4.
 */
export class TauriDesktopFingerprintProvider implements IMachineFingerprintProvider {
  async collect(): Promise<FingerprintInput> {
    throw new Error("TauriDesktopFingerprintProvider is a Phase 4 implementation");
  }
  async compute(): Promise<string> {
    throw new Error("TauriDesktopFingerprintProvider is a Phase 4 implementation");
  }
  async getMetadata(): Promise<FingerprintMetadata> {
    throw new Error("TauriDesktopFingerprintProvider is a Phase 4 implementation");
  }
}

/**
 * Stub provider for Tauri mobile. Same status as desktop.
 */
export class TauriMobileFingerprintProvider implements IMachineFingerprintProvider {
  async collect(): Promise<FingerprintInput> {
    throw new Error("TauriMobileFingerprintProvider is a Phase 4 implementation");
  }
  async compute(): Promise<string> {
    throw new Error("TauriMobileFingerprintProvider is a Phase 4 implementation");
  }
  async getMetadata(): Promise<FingerprintMetadata> {
    throw new Error("TauriMobileFingerprintProvider is a Phase 4 implementation");
  }
}
