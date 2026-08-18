import { useEffect } from "react";

/**
 * Global document-level keyboard shortcuts.
 *
 *   Ctrl/Cmd + S ..... save current document
 *   Ctrl/Cmd + N ..... start a new document of the current type
 *   Esc .............. cancel / close current dialog
 *
 * Tab / Shift+Tab / Enter are handled natively by the browser + input
 * components (screens must define their own logical focus order).
 * Arrow-key grid navigation is intentionally deferred.
 */
export function useDocumentShortcuts({
  onSave,
  onNew,
  onCancel,
  enabled = true,
}: {
  onSave?: () => void;
  onNew?: () => void;
  onCancel?: () => void;
  enabled?: boolean;
}) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "s" && onSave) {
        e.preventDefault();
        onSave();
        return;
      }
      if (mod && e.key.toLowerCase() === "n" && onNew) {
        e.preventDefault();
        onNew();
        return;
      }
      if (e.key === "Escape" && onCancel) {
        onCancel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, onSave, onNew, onCancel]);
}
