// The real system call behind src/core/share.ts: expo-sharing builds a content:// URI with a read grant (FileProvider)
// and the application/pdf type, which WhatsApp accepts as a document.
import * as Sharing from "expo-sharing";
import type { ShareDeps } from "../core/share";

export const deviceShareDeps: ShareDeps = {
  isAvailable: () => Sharing.isAvailableAsync(),
  open: (uri, title) =>
    Sharing.shareAsync(uri, {
      mimeType: "application/pdf",
      UTI: "com.adobe.pdf",
      dialogTitle: title,
    }),
};
