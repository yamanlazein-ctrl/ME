; NSIS installer hooks for Motard ERP (Tauri v2 `nsis.installerHooks`).
;
; NSIS_HOOK_POSTINSTALL — install-instance marker (specs/001-desktop-sqlite-engine T075, D-1):
;   writes a new GUID to HKCU\Software\MotardFabricsErp\InstallInstanceId ONLY IF ABSENT. An
;   update re-runs the installer and keeps the marker; an uninstall removes it, so a later
;   reinstall gets a NEW marker. The SQLite database records the marker it was created under
;   (motard_meta.install_instance_id); at startup the runtime compares the two and never
;   silently reuses data under a new installation (db_meta::evaluate_startup).
;
; NSIS_HOOK_PREUNINSTALL — removes the install-instance marker and OUR defensive autostart Run
;   value (HKCU\...\Run\MotardFabricsErp, written by main.rs on every boot because the plugin key
;   alone can vanish after one reboot on some builds). The plugin's own Run value is removed by
;   the upstream uninstaller fix (tauri-apps/tauri#12643, NSIS side); the MSI side is covered by
;   the MotardRunKeyCleanup component in wix-cleanup.wxs.
;
; CRITICAL — Uninstall ≠ Delete User Data:
; Do NOT delete %LOCALAPPDATA%\motard-erp (data\motard.db, secrets.dat, backups, logs). Business
; data must survive Remove Application so a reinstall can find it (and offer it — never take it
; over silently). Factory reset / intentional purge is an in-app operator action only — never an
; installer side-effect.
;
; DeleteRegValue on a missing value is a no-op (sets the error flag only, never aborts), so this
; is safe on machines that never ran the app. Runs in the installing user's context: HKCU is the
; same hive the app reads (per-user install; the marker is per Windows user, D-2).

!macro NSIS_HOOK_POSTINSTALL
  ClearErrors
  ReadRegStr $0 HKCU "Software\MotardFabricsErp" "InstallInstanceId"
  ${If} $0 == ""
    ; {xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx} → drop the braces (36 characters)
    System::Call 'ole32::CoCreateGuid(g .r1) i .r2'
    StrCpy $1 $1 36 1
    WriteRegStr HKCU "Software\MotardFabricsErp" "InstallInstanceId" "$1"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MotardFabricsErp"
  DeleteRegValue HKCU "Software\MotardFabricsErp" "InstallInstanceId"
  ; Intentionally no RMDir / Delete of $LOCALAPPDATA\motard-erp.
!macroend

; POSTUNINSTALL: still must not touch AppData. Left empty on purpose.
!macro NSIS_HOOK_POSTUNINSTALL
!macroend
