; NSIS installer hooks for Motard ERP (Tauri v2 `nsis.installerHooks`).
;
; Only hook defined: NSIS_HOOK_PREUNINSTALL removes OUR defensive autostart
; Run value (HKCU\...\Run\MotardFabricsErp, written by main.rs on every boot
; because the plugin key alone can vanish after one reboot on some builds).
; The plugin's own Run value is removed by the upstream uninstaller fix
; (tauri-apps/tauri#12643, NSIS side); the MSI side is covered by the
; MotardRunKeyCleanup component in wix-cleanup.wxs.
;
; DeleteRegValue on a missing value is a no-op (sets the error flag only,
; never aborts), so this is safe on machines that never ran the app.
; Runs in the uninstaller's user context, matching the HKCU hive the app
; wrote to (per-user install; elevation does not redirect HKCU).

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MotardFabricsErp"
!macroend
