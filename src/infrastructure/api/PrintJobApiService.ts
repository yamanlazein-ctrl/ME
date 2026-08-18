import type { BaseHttpClient } from "@/infrastructure/http";
import type {
  PrintJobDTO,
  CreatePrintSendInput,
  ReceivePrintInput,
  ListPrintJobsResponse,
  ListOpenPrintJobsResponse,
} from "@/contracts/printing";

export class PrintJobApiService {
  constructor(private client: BaseHttpClient) {}

  async listAll(): Promise<ListPrintJobsResponse> {
    const res = await this.client.get<ListPrintJobsResponse>("/api/printing");
    return res.data;
  }

  async findById(id: string): Promise<PrintJobDTO> {
    const res = await this.client.get<PrintJobDTO>(`/api/printing/${id}`);
    return res.data;
  }

  async listOpen(): Promise<ListOpenPrintJobsResponse> {
    const res = await this.client.get<ListOpenPrintJobsResponse>("/api/printing/open");
    return res.data;
  }

  async createSend(input: CreatePrintSendInput): Promise<PrintJobDTO> {
    const res = await this.client.post<PrintJobDTO>("/api/printing/send", input);
    return res.data;
  }

  async receive(input: ReceivePrintInput): Promise<PrintJobDTO> {
    const res = await this.client.post<PrintJobDTO>("/api/printing/receive", input);
    return res.data;
  }
}
