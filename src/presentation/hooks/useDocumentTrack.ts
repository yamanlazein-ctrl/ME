import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { container } from "@/infrastructure/container";

/**
 * Invoice-tracking feed (invoices, returns, print jobs, settlement batches),
 * filtered, sorted by document date and PAGED ON THE SERVER
 * (GET /api/documents/track). The screen used to download every return, print
 * job and voucher of the company to build this list in the browser.
 */
export type TrackKind = "entry" | "sale" | "return" | "print_send" | "print_receive" | "settlement";

export type DocumentTrackRow = {
  kind: TrackKind;
  id: string;
  number: string | null;
  date: string;
  createdAt: string;
  partyId: string | null;
  partyKind: "customer" | "supplier" | null;
  partyName: string | null;
  total: number | null;
  currency: string | null;
  status: string;
  quantityKg: number | null;
};

export type DocumentTrackFilter = {
  type: TrackKind | "all";
  status: "all" | "active" | "cancelled" | "draft";
  partyId?: string;
  fromDate?: string;
  toDate?: string;
  search?: string;
  page: number;
  limit: number;
};

export function useDocumentTrack(filter: DocumentTrackFilter) {
  return useQuery({
    queryKey: ["documents", "track", filter],
    queryFn: async () => {
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(filter))
        if (v !== undefined && v !== "") params[k] = String(v);
      const res = await container.http.get<{
        data: DocumentTrackRow[];
        total: number;
        hasNext: boolean;
      }>("/api/documents/track", { params });
      return res.data;
    },
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}
