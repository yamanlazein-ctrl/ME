import type { CSSProperties, ReactNode } from "react";
import { useEffect } from "react";
import { useSettings } from "@/presentation/hooks/useSettings";
import logoUrl from "@/assets/logo-motard-icon.png";
import { getCompanyContactLines, PRINT_BRAND_NAME } from "@/shared/constants/printConfig";
import "./print.css";

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
  | "STATEMENT"
  | "RECEIPT"
  | "PAYMENT";

const BADGE_LABEL: Record<PrintTypeBadge, string> = {
  PURCHASE: "PURCHASE",
  SALE: "SALE",
  RETURN_IN: "RETURN IN",
  RETURN_OUT: "RETURN OUT",
  PRINT_JOB: "PRINT JOB",
  STATEMENT: "STATEMENT",
  RECEIPT: "RECEIPT",
  PAYMENT: "PAYMENT",
};

/**
 * Unified print shell for ALL documents (invoices, vouchers, statements…).
 *
 * Header contract (locked — one canonical layout for every invoice):
 *   • NOTHING above the brand row
 *   • Two physical columns (LTR grid, full paper width):
 *       LEFT  = logo alone
 *       RIGHT = company name + address/phone lines (stacked)
 *   • Exact five contact lines (getCompanyContactLines) — never
 *     concatenated, never LTR-reversed, never duplicated from settings
 *   • Gold divider, then document title + party/meta grid
 *
 * Footer contract (locked):
 *   • Thanks line on the last page only — contact is NOT repeated here
 */
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
  typeBadge?: PrintTypeBadge;
  pageNumber?: number;
  totalPages?: number;
  hideFooter?: boolean;
  extraMeta?: PrintMetaItem[];
}) {
  const s = useSettings();
  const p = s.printing;
  const showLogo = p.showLogo !== false;
  const paper = p.paperSize || "A4";
  const allMeta = [...(meta ?? []), ...(extraMeta ?? [])];
  const isFirstPage = pageNumber == null || pageNumber === 1;
  const showFooter =
    !hideFooter &&
    (pageNumber == null || totalPages == null || pageNumber === totalPages);

  const contactLines = getCompanyContactLines();

  // Stamp paper size on the print portal root so named @page starts THERE
  // (not on an inner .print-doc) — avoids Chrome's blank first page.
  useEffect(() => {
    const root = document.querySelector("[data-print-root]");
    if (root instanceof HTMLElement) root.dataset.paper = paper;
  }, [paper]);

  return (
    <div className="print-doc" data-paper={paper}>
      {/* ── Brand bar: logo LEFT | company + contact RIGHT (full width). ── */}
      <div className="print-brand-bar">
        {showLogo ? (
          <img className="print-logo" src={logoUrl} alt="" />
        ) : (
          <span className="print-logo-spacer" aria-hidden="true" />
        )}
        <div className={`print-brand-identity${isFirstPage ? "" : " print-brand-identity--compact"}`}>
          <div className="print-brand-name">{PRINT_BRAND_NAME}</div>
          {isFirstPage && (
            <div className="print-brand-contact">
              {contactLines.map((line) => (
                <div key={line} className="print-brand-contact-line">
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="print-header-divider" />

      <div className="print-masthead">
        <div className="print-header-title-area">
          <div className="print-title-row">
            {typeBadge && (
              <span className={`print-type-badge print-badge-${typeBadge.toLowerCase()}`}>
                {BADGE_LABEL[typeBadge]}
              </span>
            )}
            <div className="print-doc-title">{title}</div>
          </div>
          {subtitle && <div className="print-doc-subtitle">{subtitle}</div>}
        </div>
      </div>

      {(party || allMeta.length > 0) && (
        <div className="print-info-grid print-avoid-break">
          {party && (
            <div className="print-party print-meta-item">
              <span className="print-meta-label">{party.label}</span>
              <span className="print-meta-value print-party-name">{party.name}</span>
              {party.extra && (
                <span className="print-party-line">
                  {party.extra.replace(/^رمز .*?: /, "الرمز: ")}
                </span>
              )}
              {party.phone && (
                <span className="print-party-line">
                  الهاتف: <span dir="ltr">{party.phone}</span>
                </span>
              )}
              {party.address && <span className="print-party-line">{party.address}</span>}
            </div>
          )}
          {allMeta.map((m) => (
            <div key={m.label} className="print-meta-item">
              <span className="print-meta-label">{m.label}</span>
              <span className="print-meta-value">{m.value}</span>
            </div>
          ))}
        </div>
      )}

      {children}

      {totals && totals.length > 0 && (
        <div className="print-totals print-avoid-break">
          {totals.map((t) => (
            <div key={t.label} className={`print-total-row ${t.grand ? "print-grand-total" : ""}`}>
              <span>{t.label}</span>
              <span className="pd-amount pd-money" dir="ltr">
                {t.value}
              </span>
            </div>
          ))}
        </div>
      )}

      {payment && payment.length > 0 && (
        <div className="print-payment print-avoid-break">
          {payment.map((item) => (
            <div key={item.label} className="print-payment-item">
              <div className="print-payment-label">{item.label}</div>
              <div className="print-payment-value pd-money" dir="ltr">
                {item.value}
              </div>
            </div>
          ))}
        </div>
      )}

      {notes && (
        <div className="print-notes print-avoid-break">
          <span className="print-notes-label">ملاحظات:</span> {notes}
        </div>
      )}

      {signatures && signatures.length > 0 && (
        <div className="print-signatures print-avoid-break">
          {signatures.map((sig) => (
            <div key={sig} className="print-signature">
              <div className="print-signature-line">{sig}</div>
            </div>
          ))}
        </div>
      )}

      {showFooter && (
        <div className="print-footer">
          <div className="print-footer-thanks">
            {footerNote || p.footerNote || "شكراً لتعاملكم معنا"}
          </div>
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
            const cls = [
              c.align === "center" ? "pd-center" : "",
              c.amount ? "pd-amount amount-col" : "",
            ]
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
        {rows.map((row, i) => {
          if (row.length === 1 && typeof row[0] === "object" && (row[0] as ReactNode) != null) {
            const el = row[0] as React.ReactElement;
            if ((el as { key?: unknown }).key === "detail") {
              return (
                <tr key={i} className="print-detail-row">
                  <td colSpan={columns.length}>{el}</td>
                </tr>
              );
            }
          }
          return (
            <tr key={i}>
              {row.map((cell, j) => {
                const c = columns[j];
                const cls = [
                  c?.align === "center" ? "pd-center" : "",
                  c?.amount ? "pd-amount amount-col" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <td key={j} className={cls}>
                    {cell}
                  </td>
                );
              })}
            </tr>
          );
        })}
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
