// Fabric → colour → roll lookups for the roll picker (same search repository the desktop typeaheads use).
import { likePattern } from "./partyQueries";
import type { Phone } from "./phone";

export interface PickRow {
  id: string;
  name: string;
}
export interface PickRoll {
  id: string;
  rollNo: string;
  remainingKg: number;
  remainingPieces: number;
  pricePerKg: number;
  currency: string;
}

export async function pickFabrics(phone: Phone, q: string): Promise<PickRow[]> {
  const rows = await phone.repos.searchRepo.searchFabrics(
    phone.identity.tenantId,
    q,
    q ? likePattern(q) : "%",
    30,
  );
  return rows.map((r) => ({ id: String(r.id), name: String(r.name) }));
}

export async function pickColors(phone: Phone, fabricId: string, q = ""): Promise<PickRow[]> {
  const rows = await phone.repos.searchRepo.searchColors(
    phone.identity.tenantId,
    fabricId,
    q ? likePattern(q) : "%",
    60,
  );
  return rows.map((r) => ({ id: String(r.id), name: String(r.name) }));
}

export async function pickRolls(phone: Phone, colorId: string): Promise<PickRoll[]> {
  const rows = await phone.repos.searchRepo.searchRolls(
    phone.identity.tenantId,
    colorId,
    "in_stock",
    "%",
    100,
  );
  return rows.map((r) => ({
    id: String(r.id),
    rollNo: String(r.rollNo),
    remainingKg: Number(r.remainingKg),
    remainingPieces: Number(r.remainingPieces ?? 0),
    pricePerKg: Number(r.pricePerKg ?? 0),
    currency: String(r.currency ?? ""),
  }));
}
