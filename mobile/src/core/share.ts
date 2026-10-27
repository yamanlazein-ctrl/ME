// Share a PDF and send it to a customer on WhatsApp (FR-29, FR-30, E13, E14). Nothing is ever sent automatically: WhatsApp
// opens on the customer's chat with the PDF attached and the user presses send. The system calls are injected, so the
// fallback order is unit tested.

/** Local numbers start with one 0 (0933 123 456); WhatsApp needs the country code. Syria is the company's market. */
export const DEFAULT_COUNTRY_CODE = "963";

/** The digits WhatsApp expects (country code first, no + or 00), or null when the text is not a usable number. */
export function whatsappDigits(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/[^\d]/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = DEFAULT_COUNTRY_CODE + digits.slice(1);
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

export type SendRoute = "whatsapp" | "wa.me" | "share";

export interface ShareDeps {
  /** Opens the system share sheet on the PDF. */
  sharePdf(uri: string): Promise<void>;
  /** Android intent to com.whatsapp with `jid` and the PDF stream. Throws when WhatsApp is missing or refuses. */
  openWhatsApp(args: { jid: string; note: string; contentUri: string }): Promise<void>;
  openUrl(url: string): Promise<void>;
  /** A content:// URI another app may read for a file in the app cache. */
  contentUri(fileUri: string): Promise<string>;
}

export async function sharePdf(uri: string, deps: Pick<ShareDeps, "sharePdf">): Promise<void> {
  await deps.sharePdf(uri);
}

export interface SendResult {
  /** Which route opened: the WhatsApp intent, else the wa.me link followed by the share sheet. */
  route: SendRoute;
  /** The routes tried, in order. */
  tried: SendRoute[];
}

export async function sendToCustomer(
  args: { phone: string; note: string; pdfUri: string },
  deps: ShareDeps,
): Promise<SendResult> {
  const digits = whatsappDigits(args.phone);
  if (!digits) throw new Error("رقم الهاتف غير صالح");
  try {
    const contentUri = await deps.contentUri(args.pdfUri);
    await deps.openWhatsApp({ jid: `${digits}@s.whatsapp.net`, note: args.note, contentUri });
    return { route: "whatsapp", tried: ["whatsapp"] };
  } catch {
    // WhatsApp is missing or the intent failed: the chat link, then the share sheet for the PDF.
  }
  const tried: SendRoute[] = [];
  try {
    await deps.openUrl(`https://wa.me/${digits}?text=${encodeURIComponent(args.note)}`);
    tried.push("wa.me");
  } catch {
    // no browser either: the share sheet below still lets the user send the file
  }
  await deps.sharePdf(args.pdfUri);
  tried.push("share");
  return { route: "share", tried };
}
