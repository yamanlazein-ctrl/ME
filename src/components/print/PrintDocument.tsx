import type { CSSProperties, ReactNode } from "react";
import { useSettings } from "@/presentation/hooks/useSettings";
import logoUrl from "@/assets/logo-motard-icon.png";
import {
  FIXED_PRINT_FOOTER_LINES,
  PRINT_BRAND_NAME,
} from "@/shared/constants/printConfig";
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
 * Header contract (locked):
 *   • NOTHING above the brand row (no title, no date, no contact)
 *   • Logo on the LEFT · "Motard Fabrics Group" on the RIGHT
 *   • Gold divider
 *   • Then document title + readable party/meta
 *
 * Footer contract (locked):
 *   • Contact lines once only, at the bottom (FIXED_PRINT_FOOTER_LINES)
 *   • Never repeat contact in the header
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
  const allMeta = [...(meta ?? []), ...(extraMeta ?? [])];
  const showFooter =
    !hideFooter &&
    (pageNumber == null || totalPages == null || pageNumber === totalPages);

  return (
    <div className="print-doc">
      {/* ── Brand bar: logo LEFT + Motard RIGHT. Nothing above. ── */}
      <div className="print-brand-bar">
        {showLogo ? (
          <img className="print-logo" src={logoUrl} alt="" />
        ) : (
          <span />
        )}
        <div className="print-brand-name">{PRINT_BRAND_NAME}</div>
      </div>

      <div className="print-header-divider" />

      {/* ── Document title ── */}
      <div className="print-header-title-area">
        {typeBadge && (
          <span className={`print-type-badge print-badge-${typeBadge.toLowerCase()}`}>
            {BADGE_LABEL[typeBadge]}
          </span>
        )}
        <div className="print-doc-title">{title}</div>
        {subtitle && <div className="print-doc-subtitle">{subtitle}</div>}
      </div>

      {/* ── Party + meta — stacked for readability, not one jammed strip ── */}
      {party && (
        <div className="print-party print-avoid-break">
          <div className="print-party-side">
            <div className="print-party-label">{party.label}</div>
            <div className="print-party-name">{party.name}</div>
            {party.extra && (
              <div className="print-party-line">
                {party.extra.replace(/^رمز .*?: /, "الرمز: ")}
              </div>
            )}
            {party.phone && (
              <div className="print-party-line">
                الهاتف: <span dir="ltr">{party.phone}</span>
              </div>
            )}
            {party.address && <div className="print-party-line">{party.address}</div>}
          </div>
        </div>
      )}

      {allMeta.length > 0 && (
        <div className="print-meta print-avoid-break">
          {allMeta.map((m) => (
            <div key={m.label} className="print-meta-item">
              <span className="print-meta-label">{m.label}</span>
              <span className="print-meta-value">{m.value}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Body ── */}
      {children}

      {/* ── Totals ── */}
      {totals && totals.length > 0 && (
        <div className="print-totals print-avoid-break">
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
        <div className="print-payment print-avoid-break">
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
        <div className="print-notes print-avoid-break">
          <span className="print-notes-label">ملاحظات:</span> {notes}
        </div>
      )}

      {/* ── Signatures ── */}
      {signatures && signatures.length > 0 && (
        <div className="print-signatures print-avoid-break">
          {signatures.map((sig) => (
            <div key={sig} className="print-signature">
              <div className="print-signature-line">{sig}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Footer: contact once, last page only ── */}
      {showFooter && (
        <div className="print-footer">
          <div className="print-footer-thanks">
            {footerNote || p.footerNote || "شكراً لتعاملكم معنا"}
          </div>
          {FIXED_PRINT_FOOTER_LINES.map((line) => (
            <div key={line} className="print-owner-contact">
              {line}
            </div>
          ))}
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
