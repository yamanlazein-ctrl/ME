import type { BaseHttpClient } from "@/infrastructure/http";
import type {
  PartyStatementDTO,
  StatementFilter,
  SettleResponse,
  SettleInput,
  SettleInvoicesInput,
  SettleInvoicesResponse,
} from "@/contracts/statement";
import type { PartyKind } from "@/domain/entities/Party";

export class StatementApiService {
  constructor(private client: BaseHttpClient) {}

  async getStatement(
    partyId: string,
    kind: PartyKind,
    filter?: StatementFilter,
  ): Promise<PartyStatementDTO> {
    const res = await this.client.get<PartyStatementDTO>(
      `/api/${kind === "customer" ? "customers" : "suppliers"}/${partyId}/statement`,
      { params: filter as Record<string, string> },
    );
    return res.data;
  }

  async settle(partyId: string, kind: PartyKind, input?: SettleInput): Promise<SettleResponse> {
    const res = await this.client.post<SettleResponse>(
      `/api/${kind === "customer" ? "customers" : "suppliers"}/${partyId}/statement/settle`,
      input ?? {},
    );
    return res.data;
  }

  async settleInvoices(
    partyId: string,
    kind: PartyKind,
    input: SettleInvoicesInput,
  ): Promise<SettleInvoicesResponse> {
    const res = await this.client.post<SettleInvoicesResponse>(
      `/api/${kind === "customer" ? "customers" : "suppliers"}/${partyId}/statement/settle-invoices`,
      input,
    );
    return res.data;
  }
}
