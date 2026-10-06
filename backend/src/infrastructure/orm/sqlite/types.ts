/**
 * SQLite column types for the desktop engine (specs/001-desktop-sqlite-engine,
 * data-model.md §2, task T032).
 *
 * Every type reproduces what the code receives from PostgreSQL through Drizzle
 * today, so repositories and domain code see identical values on both engines:
 *
 * | PG (live fingerprint)            | SQLite storage                 | JS value (as today)          |
 * |----------------------------------|--------------------------------|------------------------------|
 * | numeric(p,s)  mode:"number"      | INTEGER ×10^s                  | number  (= Number(pgText))   |
 * | numeric(p,s)  default mode       | INTEGER ×10^s                  | string  (pgText, s decimals) |
 * | uuid                             | TEXT canonical lower-case      | string                       |
 * | timestamptz                      | TEXT `YYYY-MM-DDTHH:MM:SS.ffffffZ` | Date (= new Date(pgText)) |
 * | date                             | TEXT `YYYY-MM-DD`              | string                       |
 * | boolean                          | INTEGER 0/1                    | boolean                      |
 * | jsonb                            | TEXT, jsonb key order          | parsed value                 |
 * | text[] / uuid[]                  | TEXT JSON array                | string[]                     |
 * | inet                             | TEXT, PG canonical form        | string                       |
 *
 * Live scales (fingerprint, authoritative over the T032 list): (14,2) ×41,
 * (12,2) ×15, (18,6) ×5, (7,2) ×4, (14,4) ×3, (5,4) ×2, (14,3) ×1.
 *
 * Rejections carry the PostgreSQL SQLSTATE `code` and message text, so the
 * error mapping (T047) treats them exactly like the PG errors.
 */
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { customType } from "drizzle-orm/sqlite-core";
import { transactionTimestamp } from "./clock.js";

/** An input rejected the way PostgreSQL rejects it (same SQLSTATE and message). */
export class SqliteValueError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "SqliteValueError";
  }
}

// ─── numeric(p,s) ──────────────────────────────────────────────────────────

const NUMERIC_INPUT = /^\s*([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?\s*$/;

/**
 * PG `numeric(p,s)` assignment as an exact scaled integer: the value's shortest
 * decimal text (what node-pg sends for a JS number) is rounded half away from
 * zero to `scale` digits; magnitudes that do not fit `precision` overflow.
 */
export function toScaledInteger(value: number | string | bigint, precision: number, scale: number): bigint {
  if (typeof value === "bigint") value = value.toString();
  if (typeof value === "number" && !Number.isFinite(value)) {
    if (Number.isNaN(value)) {
      // PG stores NaN in numeric(p,s); an INTEGER column cannot. NaN money is
      // always a defect upstream, so it is refused rather than mangled.
      throw new SqliteValueError("22P02", `invalid input syntax for type numeric: "NaN"`);
    }
    throw new SqliteValueError(
      "22003",
      "numeric field overflow",
      `A field with precision ${precision}, scale ${scale} cannot hold an infinite value.`,
    );
  }
  const text = String(value);
  const m = NUMERIC_INPUT.exec(text);
  if (!m) throw new SqliteValueError("22P02", `invalid input syntax for type numeric: "${text}"`);
  const negative = m[1] === "-";
  const intPart = m[2] ?? "";
  const fracPart = m[3] ?? m[4] ?? "";
  const exp = m[5] ? Number.parseInt(m[5], 10) : 0;
  // value = digits × 10^(exp − fracPart.length); we want it × 10^scale.
  let digits = (intPart + fracPart).replace(/^0+(?=\d)/, "");
  const shift = exp - fracPart.length + scale;
  let magnitude: bigint;
  if (shift >= 0) {
    magnitude = BigInt(digits + "0".repeat(shift));
  } else {
    const drop = -shift;
    if (drop > digits.length) digits = "0".repeat(drop - digits.length) + digits;
    const kept = digits.slice(0, digits.length - drop) || "0";
    const firstDropped = digits.charCodeAt(digits.length - drop) - 48;
    magnitude = BigInt(kept) + (firstDropped >= 5 ? 1n : 0n); // half away from zero
  }
  if (magnitude >= 10n ** BigInt(precision)) {
    throw new SqliteValueError(
      "22003",
      "numeric field overflow",
      `A field with precision ${precision}, scale ${scale} must round to an absolute value less than 10^${precision - scale}.`,
    );
  }
  return negative ? -magnitude : magnitude;
}

/** PG `numeric(p,s)` text output: exactly `scale` decimals ("12.50", "-0.05", "0.00"). */
export function formatScaled(scaled: bigint, scale: number): string {
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(scale + 1, "0");
  const body = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative ? `-${body}` : body;
}

function driverInteger(scaled: bigint): number | bigint {
  return scaled >= BigInt(Number.MIN_SAFE_INTEGER) && scaled <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(scaled)
    : scaled; // better-sqlite3 binds BigInt as an exact int64 — (18,6) stays exact
}

function fromDriverInteger(value: number | bigint | string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  return BigInt(value);
}

type DecimalConfig = { precision: number; scale: number };

/** Scaled-integer column factory for both Drizzle read modes (toDriver gets no config, so it is bound here). */
function scaledColumn<TData extends number | string>(mode: "number" | "string") {
  return (name: string, config: DecimalConfig) =>
    customType<{ data: TData; driverData: number | bigint }>({
      dataType: () => "integer",
      toDriver: (value) => driverInteger(toScaledInteger(value as number | string, config.precision, config.scale)),
      fromDriver: (value) => {
        const text = formatScaled(fromDriverInteger(value), config.scale);
        return (mode === "number" ? Number(text) : text) as TData;
      },
    })(name);
}

/** `numeric(p,s)` with Drizzle `mode: "number"` on PG → JS number. */
export const numeric = scaledColumn<number>("number");
/** `decimal(p,s)` / `numeric(p,s)` in Drizzle's default string mode on PG → PG text. */
export const decimalString = scaledColumn<string>("string");

// ─── uuid ──────────────────────────────────────────────────────────────────

const UUID_INPUT = /^[0-9a-f]{4}(?:-?[0-9a-f]{4}){7}$/i;

/** PG uuid input rules (braces optional; hyphens only between 4-digit groups) → canonical lower-case. */
export function canonicalUuid(value: string): string {
  const raw = String(value);
  const inner = raw.startsWith("{") && raw.endsWith("}") ? raw.slice(1, -1) : raw;
  if (!UUID_INPUT.test(inner)) throw new SqliteValueError("22P02", `invalid input syntax for type uuid: "${raw}"`);
  const hex = inner.replace(/-/g, "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const uuid = customType<{ data: string; driverData: string }>({
  dataType: () => "text",
  toDriver: canonicalUuid,
  fromDriver: (value) => value,
});

/** Default for uuid primary keys (`gen_random_uuid()` on PG). */
export const randomUuid = (): string => randomUUID();

// ─── timestamptz ───────────────────────────────────────────────────────────

const MICROS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/**
 * Written like Drizzle PG (`value.toISOString()`, ms) padded to µs; the
 * transaction clock's µs text passes through unchanged. Read like Drizzle PG:
 * `new Date(text)` (V8 truncates µs to ms on both engines).
 */
export const timestamptz = customType<{ data: Date; driverData: string }>({
  dataType: () => "text",
  toDriver(value) {
    if (typeof value === "string" && MICROS_UTC.test(value)) return value;
    const iso = (value as Date).toISOString(); // throws on invalid Date, as on PG
    return `${iso.slice(0, -1)}000Z`;
  },
  fromDriver: (value) => new Date(value),
});

const TS_INPUT = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6})\d*)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/**
 * PG `value::timestamptz` for a bound value → stored UTC µs text, keeping microseconds
 * (raw-SQL twins of `$n::timestamptz`). A Date carries ms; text may carry µs and an offset
 * (no offset = UTC, the desktop cluster's TimeZone).
 */
export function toTimestamptzText(value: Date | string): string {
  if (value instanceof Date) {
    const iso = value.toISOString();
    return `${iso.slice(0, -1)}000Z`;
  }
  const raw = String(value).trim();
  const m = TS_INPUT.exec(raw);
  if (!m) throw new SqliteValueError("22007", `invalid input syntax for type timestamp with time zone: "${raw}"`);
  const [, y, mo, d, h, mi, s, frac = "", tz = "Z"] = m;
  let offsetMin = 0;
  if (tz.toUpperCase() !== "Z") {
    const t = /^([+-])(\d{2}):?(\d{2})?$/.exec(tz)!;
    offsetMin = (t[1] === "-" ? -1 : 1) * (Number(t[2]) * 60 + Number(t[3] ?? 0));
  }
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) - offsetMin * 60_000;
  const micros = BigInt(ms) * 1000n + BigInt(frac.padEnd(6, "0"));
  const base = new Date(Number(micros / 1000000n) * 1000).toISOString().slice(0, 19);
  return `${base}.${(micros % 1000000n).toString().padStart(6, "0")}Z`;
}

/** PG's JSON rendering of a timestamptz (to_json / jsonb_build_object): "…T12:34:56.1234+00:00". */
export function pgJsonTimestamptz(storedText: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/.exec(storedText);
  if (!m) return storedText;
  const frac = m[2].replace(/0+$/, "");
  return `${m[1]}${frac ? `.${frac}` : ""}+00:00`;
}

/**
 * `$defaultFn` for timestamptz columns that default to `now()`: the transaction
 * clock's µs text, typed as the column's data type (stored unchanged by toDriver).
 */
export const nowDefault = (): Date => transactionTimestamp() as unknown as Date;

// ─── date ──────────────────────────────────────────────────────────────────

const DATE_INPUT = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})\s*$/;

/** PG `date` input in ISO form → normalized `YYYY-MM-DD`; impossible dates are rejected. */
export function canonicalDate(value: string | Date): string {
  if (value instanceof Date) {
    // node-pg serializes a Date in local time; PG keeps that local calendar day.
    const y = value.getFullYear();
    return `${String(y).padStart(4, "0")}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  const raw = String(value);
  const m = DATE_INPUT.exec(raw);
  if (!m) throw new SqliteValueError("22007", `invalid input syntax for type date: "${raw}"`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (mo < 1 || mo > 12 || d < 1 || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    throw new SqliteValueError("22008", `date/time field value out of range: "${raw}"`);
  }
  return `${m[1]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export const date = customType<{ data: string; driverData: string }>({
  dataType: () => "text",
  toDriver: (value) => canonicalDate(value as string | Date),
  fromDriver: (value) => value,
});

// ─── boolean ───────────────────────────────────────────────────────────────

const BOOL_TRUE = new Set(["t", "true", "y", "yes", "on", "1"]);
const BOOL_FALSE = new Set(["f", "false", "n", "no", "off", "0"]);

export function toBoolInteger(value: boolean | string | number): 0 | 1 {
  if (typeof value === "boolean") return value ? 1 : 0;
  const t = String(value).trim().toLowerCase();
  if (BOOL_TRUE.has(t)) return 1;
  if (BOOL_FALSE.has(t)) return 0;
  throw new SqliteValueError("22P02", `invalid input syntax for type boolean: "${String(value)}"`);
}

export const boolean = customType<{ data: boolean; driverData: number }>({
  dataType: () => "integer",
  toDriver: (value) => toBoolInteger(value),
  fromDriver: (value) => value === 1 || (value as unknown) === 1n,
});

// ─── jsonb ─────────────────────────────────────────────────────────────────

/** jsonb key order: shorter keys first, then byte order (PG `compareJsonbObjectKeys`). */
function compareJsonbKeys(a: string, b: string): number {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length !== bb.length ? ba.length - bb.length : Buffer.compare(ba, bb);
}

function normalizeJsonb(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJsonb);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort(compareJsonbKeys)) out[k] = normalizeJsonb(src[k]);
    return out;
  }
  return value;
}

/** Drizzle PG jsonb writes `JSON.stringify(value)`; PG then normalizes key order. */
export function toJsonbText(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) throw new SqliteValueError("22P02", "invalid input syntax for type json");
  const parsed = JSON.parse(text) as unknown;
  if (text.includes("\\u0000")) {
    throw new SqliteValueError("22P05", "unsupported Unicode escape sequence", "\\u0000 cannot be converted to text.");
  }
  // Stored text follows jsonb key order for string keys. V8 lists integer-like
  // keys first on both engines' JSON.parse, so the values read back are identical.
  return JSON.stringify(normalizeJsonb(parsed));
}

export const jsonb = customType<{ data: unknown; driverData: string }>({
  dataType: () => "text",
  toDriver: toJsonbText,
  fromDriver: (value) => JSON.parse(value) as unknown,
});

// ─── arrays (text[] / uuid[]) ──────────────────────────────────────────────

export const textArray = customType<{ data: string[]; driverData: string }>({
  dataType: () => "text",
  toDriver: (value) => JSON.stringify(value.map((v) => (v === null ? null : String(v)))),
  fromDriver: (value) => JSON.parse(value) as string[],
});

export const uuidArray = customType<{ data: string[]; driverData: string }>({
  dataType: () => "text",
  toDriver: (value) => JSON.stringify(value.map((v) => (v === null ? null : canonicalUuid(v)))),
  fromDriver: (value) => JSON.parse(value) as string[],
});

// ─── inet ──────────────────────────────────────────────────────────────────

/** IPv6 text as PG prints it (BIND `inet_ntop6`: compress the longest ≥2 zero run). */
function formatIpv6(words: number[]): string {
  let best = { base: -1, len: 0 };
  let cur = { base: -1, len: 0 };
  words.forEach((w, i) => {
    if (w === 0) {
      cur = cur.base === -1 ? { base: i, len: 1 } : { base: cur.base, len: cur.len + 1 };
      if (cur.len > best.len) best = { ...cur };
    } else {
      cur = { base: -1, len: 0 };
    }
  });
  if (best.len < 2) best = { base: -1, len: 0 };
  const embeddedV4 = best.base === 0 && (best.len === 6 || (best.len === 5 && words[5] === 0xffff));
  let out = "";
  for (let i = 0; i < 8; i++) {
    if (best.base !== -1 && i >= best.base && i < best.base + best.len) {
      if (i === best.base) out += ":";
      continue;
    }
    if (i !== 0) out += ":";
    if (i === 6 && embeddedV4) {
      out += `${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`;
      break;
    }
    out += words[i].toString(16);
  }
  if (best.base !== -1 && best.base + best.len === 8) out += ":";
  return out;
}

function parseIpv6(text: string): number[] {
  let head = text;
  const tail: number[] = [];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(head);
  if (v4) {
    const o = v4[1].split(".").map(Number);
    tail.push((o[0] << 8) | o[1], (o[2] << 8) | o[3]);
    head = head.slice(0, -v4[1].length);
    if (head.endsWith(":") && !head.endsWith("::")) head = head.slice(0, -1);
  }
  const [l, r] = head.includes("::") ? head.split("::") : [head, undefined];
  const left = l ? l.split(":").map((h) => Number.parseInt(h, 16)) : [];
  const right = r ? r.split(":").map((h) => Number.parseInt(h, 16)) : [];
  const fill = 8 - tail.length - left.length - right.length;
  return [...left, ...(r !== undefined ? new Array(fill).fill(0) : []), ...right, ...tail];
}

/** PG `inet` input → its canonical output (`/32` and `/128` host masks are omitted). */
export function canonicalInet(value: string): string {
  const raw = String(value).trim();
  const [addr, prefixText, extra] = raw.split("/");
  const family = isIP(addr);
  const maxPrefix = family === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? maxPrefix : Number(prefixText);
  if (!family || extra !== undefined || !/^\d*$/.test(prefixText ?? "") || prefix > maxPrefix) {
    throw new SqliteValueError("22P02", `invalid input syntax for type inet: "${String(value)}"`);
  }
  const host = family === 4 ? addr.split(".").map(Number).join(".") : formatIpv6(parseIpv6(addr.toLowerCase()));
  return prefix === maxPrefix ? host : `${host}/${prefix}`;
}

export const inet = customType<{ data: string; driverData: string }>({
  dataType: () => "text",
  toDriver: canonicalInet,
  fromDriver: (value) => value,
});
