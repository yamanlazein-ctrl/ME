import type { BaseHttpClient } from "@/infrastructure/http";

export type SyncConflictDecision = "keep-server" | "rebase" | "withdraw";

export type SyncConflictRow = {
  id: string;
  opId: string;
  entityType: string;
  entityId: string;
  operation: "update" | "cancel";
  baseVersion: number | null;
  serverVersion: number | null;
  status: "open" | "resolved";
  createdAt: string;
  resolvedAt: string | null;
  resolution: Record<string, unknown> | null;
  localIntent: Record<string, unknown> | null;
};

export class SyncConflictsApiService {
  constructor(private client: BaseHttpClient) {}

  async list(all = false): Promise<SyncConflictRow[]> {
    const res = await this.client.get<{ items: SyncConflictRow[] }>(
      all ? "/api/sync/conflicts?all=1" : "/api/sync/conflicts",
    );
    return res.data.items ?? [];
  }

  async resolve(
    conflictId: string,
    decision: SyncConflictDecision,
    note?: string,
  ): Promise<SyncConflictRow> {
    const res = await this.client.post<{ resolved: SyncConflictRow }>(
      "/api/sync/conflicts/resolve",
      { conflictId, decision, note },
    );
    return res.data.resolved;
  }
}
