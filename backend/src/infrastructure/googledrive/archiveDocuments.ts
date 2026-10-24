/**
 * The archive documents: the invoice PDFs that go to Drive.
 *
 * The layout is the shared one; this module produces the DATA for it from the database and hands
 * the result to the shell for rendering (see `renderBridge.ts`).
 *
 * The PDF is the archive's document; the CSV export stays as the fallback for when there is no
 * shell on the other end to render it.
 */
import { and, gte, lt } from "drizzle-orm";
import { invoices } from "../orm/sqlite/schemas/invoice.table.js";
import type { DB } from "../orm/sqlite/drizzleCompat.js";
import { invoiceArchiveHtml } from "./archiveHtml.js";
import { awaitRender, discardRender, requestRender } from "./renderBridge.js";

/** How long the backend waits for the shell to render one document, once the shell is known. */
const RENDER_WAIT_MS = 20_000;
/**
 * How long the FIRST attempt waits. The shell has to notice the request, render it and post it
 * back, so a generous wait is right — but a backend with no shell at all (a test, or a desktop
 * whose shell failed to start) must not pay the full timeout for every document, so the first
 * attempt uses a short one to find out.
 */
const FIRST_WAIT_MS = 3_000;

export type RenderedDocument = {
  /** The business document id — the Drive upsert key is derived from it. */
  documentId: string;
  /** The category the file belongs to. */
  section: string;
  /** The file name. */
  fileName: string;
  /** Where the shell staged it. */
  path: string;
  /** The hash of the staged file. */
  sha256: string;
  sizeBytes: number;
};

/**
 * Whether a shell is rendering for this backend.
 *
 * `null` = not known yet. It becomes `false` when a request is never picked up (there is no shell
 * on the other end) and `true` as soon as one comes back rendered. Without this, a backend with no
 * shell — every test, and a desktop whose shell failed to start — would wait the full timeout for
 * every document.
 *
 * "No shell" is re-checked after `REPROBE_MS`: it used to be final for the process lifetime, so one
 * slow first answer (the shell busy at boot) switched the PDFs off until the backend restarted.
 */
let shellCanRender: boolean | null = null;
let absentSince = 0;
const REPROBE_MS = 30 * 60 * 1000;

export function resetRenderAvailability(): void {
  shellCanRender = null;
}

/** Whether the shell is known to be rendering. */
export function renderAvailable(): boolean | null {
  return shellCanRender;
}

/** The documents of a period: the invoices that belong to it. */
async function periodInvoices(
  db: DB,
  periodKey: string,
): Promise<Array<{ id: string; kind: "sale" | "entry"; number: string; date: string }>> {
  const [y, m] = periodKey.split("-").map(Number);
  const from = `${periodKey}-01`;
  const to = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  const rows = await db
    .select({
      id: invoices.id,
      type: invoices.type,
      number: invoices.number,
      date: invoices.date,
    })
    .from(invoices)
    .where(and(gte(invoices.date, from), lt(invoices.date, to)));
  return rows
    .filter((r) => r.type === "sale" || r.type === "entry")
    .map((r) => ({
      id: r.id,
      kind: r.type as "sale" | "entry",
      number: r.number,
      date: r.date,
    }));
}

/**
 * Render the documents of one period.
 *
 * The render is requested through the shell; the returned files are the ones that go to Drive.
 * A period whose shell is absent yields nothing, and the caller falls back to the CSV export.
 *
 * `only` limits the render to the documents that are new or changed since they were last archived:
 * re-rendering an unchanged invoice produces a new file (a PDF carries its creation time) and would
 * re-upload every document of the period on every pass.
 */
export async function renderPeriodDocuments(
  db: DB,
  runId: string,
  periodKey: string,
  only?: ReadonlySet<string>,
): Promise<RenderedDocument[]> {
  if (shellCanRender === false && Date.now() - absentSince > REPROBE_MS) shellCanRender = null;
  if (shellCanRender === false) return [];
  const out: RenderedDocument[] = [];

  for (const inv of await periodInvoices(db, periodKey)) {
    if (only && !only.has(inv.id)) continue;
    const built = await invoiceArchiveHtml(db, inv.id, inv.kind);
    if (!built) continue;
    const section = inv.kind === "sale" ? "sale_invoices" : "entry_invoices";
    const requestId = await requestRender(db, {
      runId,
      artifactId: inv.id,
      format: "pdf",
      outName: `${built.fileStem}.pdf`,
      paper: "A4",
      html: built.html,
    });
    const outcome = await awaitRender(
      db,
      requestId,
      shellCanRender === null ? FIRST_WAIT_MS : RENDER_WAIT_MS,
    );
    // The outcome is known (or nobody is coming): the request has served its purpose.
    await discardRender(db, requestId);
    if (outcome.kind === "absent") {
      // Nobody took it: there is no shell on the other end. Stop asking until the re-probe.
      shellCanRender = false;
      absentSince = Date.now();
      return out;
    }
    if (outcome.kind === "failed") continue; // this document failed; the CSV is its fallback
    shellCanRender = true;
    out.push({
      documentId: inv.id,
      section,
      fileName: `${built.fileStem}.pdf`,
      path: outcome.path,
      sha256: outcome.sha256,
      sizeBytes: outcome.sizeBytes,
    });
  }
  return out;
}
