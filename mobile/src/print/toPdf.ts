import { printToFileAsync } from "expo-print";

/** Renders an HTML document to a PDF file in the app cache and returns its URI. */
export async function htmlToPdf(html: string): Promise<string> {
  const { uri } = await printToFileAsync({ html, base64: false });
  return uri;
}
