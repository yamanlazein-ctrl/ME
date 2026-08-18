import type { BaseHttpClient } from "@/infrastructure/http";
import type {
  ExpenseDTO,
  CreateExpenseInput,
  ExpenseFilter,
  ListExpensesResponse,
} from "@/contracts/expenses";

export class ExpenseApiService {
  constructor(private client: BaseHttpClient) {}

  async list(filter?: ExpenseFilter): Promise<ListExpensesResponse> {
    const res = await this.client.get<ListExpensesResponse>("/api/expenses", {
      params: filter as Record<string, string>,
    });
    return res.data;
  }

  async findById(id: string): Promise<ExpenseDTO> {
    const res = await this.client.get<ExpenseDTO>(`/api/expenses/${id}`);
    return res.data;
  }

  async create(input: CreateExpenseInput): Promise<ExpenseDTO> {
    const res = await this.client.post<ExpenseDTO>("/api/expenses", input);
    return res.data;
  }

  async update(id: string, input: Partial<CreateExpenseInput>): Promise<ExpenseDTO> {
    const res = await this.client.put<ExpenseDTO>(`/api/expenses/${id}`, input);
    return res.data;
  }

  async cancel(id: string): Promise<ExpenseDTO> {
    const res = await this.client.post<ExpenseDTO>(`/api/expenses/${id}/cancel`);
    return res.data;
  }

  async listNames(): Promise<string[]> {
    const res = await this.client.get<string[]>("/api/expenses/names");
    return res.data;
  }

  async addName(name: string): Promise<void> {
    await this.client.post("/api/expenses/names", { name });
  }
}
