import type { CSSProperties, ReactNode } from "react";
import { useSettings } from "@/presentation/hooks/useSettings";
import logoUrl from "@/assets/logo-mo-clean.png";
import { getOwnerFooterLine } from "@/shared/constants/printConfig";
import "./print.css";

/**
 * Brand identity for the print header.
 * The company name is hard-coded here (print-only) per the product spec.
 * Logo appears top-LEFT; brand name beneath; title on the right.
 * No legacy contact / tax / commercial data is shown.
 */
const BRAND_NAME = "Motard Fabrics Gruob";
const BRAND_SUBTITLE = "Motard Fabrics Group";

export type PrintMetaItem = { label: string; value: string };

export type PrintParty = {
  label: string;
  name: string;
  phone?: string;
  address?: string;
  extra?: string;
};

export type PrintTotal = { label: string; value: string; grand?: boolean };

/** Small label that identifies the document kind in the header. */
export type PrintTypeBadge =
  | "PURCHASE"
  | "SALE"
  | "RETURN_IN"
  | "RETURN_OUT"
  | "PRINT_JOB"
  | "STATEMENT";

const BADGE_LABEL: Record<PrintTypeBadge, string> = {
  PURCHASE: "PURCHASE",
  SALE: "SALE",
  RETURN_IN: "RETURN IN",
  RETURN_OUT: "RETURN OUT",
  PRINT_JOB: "PRINT JOB",
  STATEMENT: "STATEMENT",
};

export function PrintDocument({
  title,
  subtitle,
  meta,
  party,
  children,
  totals,
  payment,
  notes,
  signatures,
  footerNote,
  typeBadge,
  pageNumber,
  totalPages,
  hideFooter,
  extraMeta,
}: {
  title: string;
  subtitle?: string;
  meta?: PrintMetaItem[];
  party?: PrintParty;
  children: ReactNode;
  totals?: PrintTotal[];
  payment?: { label: string; value: string }[];
  notes?: string;
  signatures?: string[];
  footerNote?: string;
  /** Optional type label rendered inside the title box (e.g. PURCHASE / SALE). */
  typeBadge?: PrintTypeBadge;
  /** Current page number (1-based). When provided with totalPages, prints "Page X / Y". */
  pageNumber?: number;
  totalPages?: number;
  /** Hide the footer entirely. */
  hideFooter?: boolean;
  /** Extra meta items appended to the meta grid (e.g. payment method). */
  extraMeta?: PrintMetaItem[];
}) {
  const s = useSettings();
  const c = s.company;
  const p = s.printing;
  const showLogo = p.showLogo !== false;

  // Show the page-of-pages line in the header when we know how many
  // pages the document spans (used by the tracking batch print).
  const showPageMarker =
    typeof pageNumber === "number" && typeof totalPages === "number";

  const printDate = new Date().toLocaleString("ar-SY", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="print-doc">
      {/* ═══════════════════════════════════════════════════════════
          NEW UNIFIED HEADER — applies to ALL print documents.
          Row 1: Logo + Company Name (once, never repeated)
          Row 2: Gold divider
          Row 3: Document title centered
          Row 4: Party / meta info bar (name, code, currency, period)
          Print timestamp: small, top-right corner, unobtrusive
          ═══════════════════════════════════════════════════════════ */}

      {/* ── Row 1: Brand identity ── */}
      <div className="print-header-brand">
        {showLogo && <img className="print-logo" src={logoUrl} alt={BRAND_NAME} />}
        <div className="print-brand-text">
          <div className="print-company-name">{BRAND_NAME}</div>
        </div>
        {/* Timestamp: tiny, top-right, never prominent */}
        <div className="print-timestamp" style={{ marginInlineStart: "auto" }}>
          {printDate}
          {showPageMarker && ` · صفحة ${pageNumber} / ${totalPages}`}
        </div>
      </div>

      {/* ── Row 2: Gold divider ── */}
      <div className="print-header-divider" />

      {/* ── Row 3: Document title ── */}
      <div className="print-header-title-area">
        {typeBadge && (
          <span className={`print-type-badge print-badge-${typeBadge.toLowerCase()}`}>
            {BADGE_LABEL[typeBadge]}
          </span>
        )}
        <div className="print-doc-title">{title}</div>
        {subtitle && <div className="print-doc-subtitle">{subtitle}</div>}
      </div>

      {/* ── Row 4: Party / Meta info bar ──
          If party is provided, show party info (name, code, phone, address).
          If meta is provided, show meta items (currency, period, date, etc.).
          Both can coexist — party info is primary, meta is secondary. */}
      {(party || (meta && meta.length > 0)) && (
        <div className="print-header-party-bar">
          {party && (
            <>
              <div className="print-header-party-item">
                <span className="print-header-party-label">{party.label}:</span>
                <span className="print-header-party-value">{party.name}</span>
              </div>
              {party.extra && (
                <div className="print-header-party-item">
                  <span className="print-header-party-label">الرمز:</span>
                  <span className="print-header-party-value">{party.extra.replace(/رمز .*?: /, "")}</span>
                </div>
              )}
              {party.phone && (
                <div className="print-header-party-item">
                  <span className="print-header-party-label">الهاتف:</span>
                  <span className="print-header-party-value">{party.phone}</span>
                </div>
              )}
            </>
          )}
          {(meta ?? []).map((m) => (
            <div key={m.label} className="print-header-party-item">
              <span className="print-header-party-label">{m.label}:</span>
              <span className="print-header-party-value">{m.value}</span>
            </div>
          ))}
          {(extraMeta ?? []).map((m) => (
            <div key={m.label} className="print-header-party-item">
              <span className="print-header-party-label">{m.label}:</span>
              <span className="print-header-party-value">{m.value}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Body ── */}
      {children}

      {/* ── Totals ── */}
      {totals && totals.length > 0 && (
        <div className="print-totals">
          {totals.map((t) => (
            <div key={t.label} className={`print-total-row ${t.grand ? "print-grand-total" : ""}`}>
              <span>{t.label}</span>
              <span className="pd-amount">{t.value}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Payment summary ── */}
      {payment && payment.length > 0 && (
        <div className="print-payment">
          {payment.map((item) => (
            <div key={item.label} className="print-payment-item">
              <div className="print-payment-label">{item.label}</div>
              <div className="print-payment-value">{item.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Notes ── */}
      {notes && (
        <div className="print-notes">
          <span className="print-notes-label">ملاحظات:</span> {notes}
        </div>
      )}

      {/* ── Signatures ── */}
      {signatures && signatures.length > 0 && (
        <div className="print-signatures">
          {signatures.map((sig) => (
            <div key={sig} className="print-signature">
              <div className="print-signature-line">{sig}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Footer ── */}
      {!hideFooter && (
        <div className="print-footer">
          {footerNote || p.footerNote || `${c.name}${c.phone ? ` · ${c.phone}` : ""}`}
          <div className="print-owner-contact">{getOwnerFooterLine()}</div>
        </div>
      )}
    </div>
  );
}

/* ── Typed table helpers ─────────────────────────────────────────────── */

export type PrintColumn = {
  key: string;
  label: string;
  align?: "right" | "center" | "left";
  amount?: boolean;
  width?: string;
};

export function PrintTable({
  columns,
  rows,
}: {
  columns: PrintColumn[];
  rows: (string | number | ReactNode)[][];
}) {
  return (
    <table className="print-table">
      <colgroup>
        {columns.map((c) => (
          <col key={c.key} style={{ width: c.width } as CSSProperties} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {columns.map((c) => {
            const cls = [c.align === "center" ? "pd-center" : "", c.amount ? "pd-amount" : ""]
              .filter(Boolean)
              .join(" ");
            return (
              <th key={c.key} className={cls}>
                {c.label}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) => {
              const c = columns[j];
              const cls = [c?.align === "center" ? "pd-center" : "", c?.amount ? "pd-amount" : ""]
                .filter(Boolean)
                .join(" ");
              return (
                <td key={j} className={cls}>
                  {cell}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function PrintPageBreak() {
  return <div className="print-page-break" aria-hidden="true" />;
}

export function PrintNoteRow({ note }: { note?: string }) {
  if (!note) return null;
  return (
    <tr>
      <td colSpan={99} className="pd-note">
        {note}
      </td>
    </tr>
  );
}
