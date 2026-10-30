import * as FileSystem from "expo-file-system/legacy";
import { printToFileAsync } from "expo-print";

export { pdfFileName } from "./pdfName";

/**
 * Renders an HTML document to a PDF in the app cache under `fileName` (the name the receiver sees in WhatsApp) and
 * returns its file:// URI. expo-print's own output is a random name, so it is moved.
 */
export async function htmlToPdf(html: string, fileName?: string): Promise<string> {
  const { uri } = await printToFileAsync({ html, base64: false });
  if (!fileName || !FileSystem.cacheDirectory) return uri;
  const target = `${FileSystem.cacheDirectory}${fileName}`;
  await FileSystem.deleteAsync(target, { idempotent: true });
  await FileSystem.moveAsync({ from: uri, to: target });
  return target;
}
