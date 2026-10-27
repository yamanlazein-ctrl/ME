// The real system calls behind src/core/share.ts.
import * as FileSystem from "expo-file-system/legacy";
import * as IntentLauncher from "expo-intent-launcher";
import { Linking } from "react-native";
import * as Sharing from "expo-sharing";
import type { ShareDeps } from "../core/share";

const FLAG_GRANT_READ_URI_PERMISSION = 1;

export const deviceShareDeps: ShareDeps = {
  sharePdf: (uri) => Sharing.shareAsync(uri, { mimeType: "application/pdf" }),
  contentUri: (fileUri) => FileSystem.getContentUriAsync(fileUri),
  openWhatsApp: async ({ jid, note, contentUri }) => {
    await IntentLauncher.startActivityAsync("android.intent.action.SEND", {
      packageName: "com.whatsapp",
      type: "application/pdf",
      flags: FLAG_GRANT_READ_URI_PERMISSION,
      extra: {
        "android.intent.extra.STREAM": contentUri,
        "android.intent.extra.TEXT": note,
        jid,
      },
    });
  },
  openUrl: (url) => Linking.openURL(url),
};
