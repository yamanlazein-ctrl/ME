#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::process::Command;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_fingerprint,
            validate_license,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[derive(Serialize)]
struct FingerprintResult {
    hash: String,
    hostname: String,
    os: String,
}

/// Collect machine fingerprint for license binding.
/// Deterministic SHA-256 of hardware signals.
#[tauri::command]
fn get_fingerprint() -> Result<FingerprintResult, String> {
    let hostname = hostname::get_hostname().unwrap_or_default();
    let os = format!("{} {}", std::env::consts::OS, std::env::consts::ARCH);

    // Collect hardware signals (same pattern as NodeFingerprintProvider)
    let mac = get_primary_mac().unwrap_or_default();
    let machine_id = get_machine_id().unwrap_or_default();
    let cpu = get_cpu_model().unwrap_or_default();

    // Deterministic ordered JSON
    let signals = format!(
        "{{\"cpu\":\"{}\",\"hostname\":\"{}\",\"mac\":\"{}\",\"machine_id\":\"{}\",\"os\":\"{}\"}}",
        cpu, hostname, mac, machine_id, os
    );

    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    signals.hash(&mut hasher);
    let hash = format!("{:x}", hasher.finish());

    Ok(FingerprintResult {
        hash,
        hostname,
        os,
    })
}

#[derive(Deserialize)]
struct ValidateRequest {
    api_url: String,
    license_key: String,
    fingerprint: String,
}

#[derive(Serialize)]
struct ValidateResult {
    valid: bool,
    status: String,
    message: String,
    grace_remaining_days: Option<i32>,
}

/// Validate license against the backend API.
#[tauri::command]
async fn validate_license(req: ValidateRequest) -> Result<ValidateResult, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/api/license/status", req.api_url);

    let resp = client
        .get(&url)
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| format!("API connection failed: {}", e))?;

    if !resp.status().is_success() {
        return Ok(ValidateResult {
            valid: false,
            status: "connection_error".into(),
            message: format!("تعذر الاتصال بالخادم: {}", resp.status()),
            grace_remaining_days: None,
        });
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid response: {}", e))?;

    let status = body["status"].as_str().unwrap_or("unknown").to_string();
    let valid = status == "active" || status == "trial";

    Ok(ValidateResult {
        valid,
        status,
        message: if valid {
            "الترخيص ساري المفعول".into()
        } else {
            "الترخيص منتهي أو غير صالح".into()
        },
        grace_remaining_days: body["graceRemainingDays"].as_i64().map(|v| v as i32),
    })
}

fn get_primary_mac() -> Result<String, String> {
    let output = if cfg!(target_os = "windows") {
        Command::new("getmac")
            .args(["/fo", "csv", "/nh"])
            .output()
    } else {
        Command::new("sh")
            .args(["-c", "ip link show 2>/dev/null | grep -oP 'link/ether \\K[^ ]+' | head -1"])
            .output()
    };

    match output {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            // Windows getmac returns quoted CSV: "device","MAC"
            let mac = if s.contains(',') {
                s.split(',').nth(1).unwrap_or(&s).trim_matches('"').to_string()
            } else {
                s
            };
            if mac.is_empty() {
                Err("no MAC found".into())
            } else {
                Ok(mac)
            }
        }
        _ => Err("failed to get MAC".into()),
    }
}

fn get_machine_id() -> Result<String, String> {
    if cfg!(target_os = "linux") {
        std::fs::read_to_string("/etc/machine-id")
            .map(|s| s.trim().to_string())
            .map_err(|_| "no machine-id".into())
    } else if cfg!(target_os = "windows") {
        let output = Command::new("reg")
            .args(["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"])
            .output();
        match output {
            Ok(o) if o.status.success() => {
                let s = String::from_utf8_lossy(&o.stdout);
                let id = s
                    .lines()
                    .find(|l| l.contains("MachineGuid"))
                    .and_then(|l| l.split("REG_SZ").nth(1))
                    .map(|s| s.trim().to_string())
                    .unwrap_or_default();
                Ok(id)
            }
            _ => Err("no MachineGuid".into()),
        }
    } else if cfg!(target_os = "macos") {
        let output = Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output();
        match output {
            Ok(o) if o.status.success() => {
                let s = String::from_utf8_lossy(&o.stdout);
                let id = s
                    .lines()
                    .find(|l| l.contains("IOPlatformUUID"))
                    .and_then(|l| l.split('"').nth(3))
                    .map(|s| s.to_string())
                    .unwrap_or_default();
                Ok(id)
            }
            _ => Err("no IOPlatformUUID".into()),
        }
    } else {
        Err("unsupported platform".into())
    }
}

fn get_cpu_model() -> Result<String, String> {
    if cfg!(target_os = "windows") {
        let output = Command::new("wmic")
            .args(["cpu", "get", "name", "/format:value"])
            .output();
        match output {
            Ok(o) if o.status.success() => {
                let s = String::from_utf8_lossy(&o.stdout);
                let cpu = s
                    .lines()
                    .find(|l| l.starts_with("Name="))
                    .map(|l| l.trim_start_matches("Name=").trim().to_string())
                    .unwrap_or_default();
                Ok(cpu)
            }
            _ => Err("no CPU info".into()),
        }
    } else {
        let output = Command::new("sh")
            .args(["-c", "lscpu 2>/dev/null | grep 'Model name' | cut -d: -f2"])
            .output();
        match output {
            Ok(o) if o.status.success() => {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                Ok(s)
            }
            _ => Err("no CPU info".into()),
        }
    }
}
