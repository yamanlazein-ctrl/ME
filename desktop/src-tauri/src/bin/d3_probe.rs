// Standalone D3 probe: verifies DPAPI generate/persist/load without the Tauri
// runtime. Mirrors the sidecar's load_or_generate() path.
// Run: cargo run --bin d3_probe   (from desktop/src-tauri)
// secret_store is a shared module in the library crate.
use motard_fabrics_erp::secret_store::{clear_for_test, load_or_generate, persist, SecretStore};

fn main() {
    // --- Simulate "first launch": clear any existing store ---
    clear_for_test();
    println!("[probe] cleared store (simulating first launch)");

    let a = load_or_generate().expect("FIRST load_or_generate must succeed");
    println!("[probe] FIRST  jwt_secret.len={} app_master_key.len={}", a.jwt_secret.len(), a.app_master_key.len());
    assert!(!a.jwt_secret.is_empty() && !a.app_master_key.is_empty());

    // --- Simulate restart: reload from persisted (DPAPI) store ---
    let b = load_or_generate().expect("SECOND load_or_generate must succeed");
    println!("[probe] SECOND jwt_secret.len={} app_master_key.len={}", b.jwt_secret.len(), b.app_master_key.len());

    if a.jwt_secret == b.jwt_secret && a.app_master_key == b.app_master_key {
        println!("[probe] PASS: persisted values are STABLE across restarts");
    } else {
        println!("[probe] FAIL: values changed across restarts");
        std::process::exit(1);
    }

    // --- Rotate test: persist new values, confirm they stick ---
    let rotated = SecretStore {
        jwt_secret: "rotated-jwt-placeholder".to_string(),
        app_master_key: "rotated-master-placeholder".to_string(),
    };
    persist(&rotated).expect("rotate persist must succeed");
    let c = load_or_generate().expect("load after rotate must succeed");
    if c.jwt_secret == "rotated-jwt-placeholder" && c.app_master_key == "rotated-master-placeholder" {
        println!("[probe] PASS: explicit rotation persists");
    } else {
        println!("[probe] FAIL: rotation did not persist");
        std::process::exit(1);
    }

    // --- Failure case: a corrupt store must NOT crash; it regenerates ---
    {
        let p = motard_fabrics_erp::secret_store::secrets_path().expect("secrets_path");
        std::fs::write(&p, b"this is not valid dpapi ciphertext!!!").ok();
        let d = load_or_generate().expect("load after corrupt store must succeed");
        assert!(!d.jwt_secret.is_empty() && !d.app_master_key.is_empty());
        println!(
            "[probe] PASS: corrupt store handled, regenerated without crash (new jwt_secret.len={})",
            d.jwt_secret.len()
        );
        let _ = std::fs::remove_file(&p);
    }

    // --- L-6 device binding: first-launch create, re-launch verify, tamper refusal ---
    {
        use motard_fabrics_erp::device_binding::ensure_device_binding;
        let bp = {
            let mut d = dirs_sys::known_folder_local_app_data().expect("no appdata");
            d.push("motard-erp");
            d.push("device-binding.dat");
            d
        };
        let _ = std::fs::remove_file(&bp);
        assert!(
            ensure_device_binding().is_ok(),
            "L-6 first-launch bind must succeed"
        );
        assert!(
            ensure_device_binding().is_ok(),
            "L-6 re-launch verify must succeed"
        );
        // Tamper: a blob that is not valid DPAPI ciphertext must be refused.
        std::fs::write(&bp, "not-a-valid-binding").ok();
        match ensure_device_binding() {
            Ok(_) => {
                println!("[probe] FAIL: tampered device-binding was accepted");
                std::process::exit(1);
            }
            Err(_) => println!("[probe] PASS: tampered device-binding correctly REFUSED (boot refusal works)"),
        }
        let _ = std::fs::remove_file(&bp);
    }

    clear_for_test();
    println!("[probe] cleaned up; DONE");
}
