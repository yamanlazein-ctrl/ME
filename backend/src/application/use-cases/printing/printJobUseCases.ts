import type { IPrintJobRepository } from "../../ports/IPrintJobRepository.js";
import type { TenantContext, UUID } from "../../../domain/types/index.js";
import type {
  PrintJobData,
  CreatePrintJobInput,
  ReceivePrintJobInput,
} from "../../../domain/entities/PrintJob.js";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export async function createPrintJobUseCase(
  repo: IPrintJobRepository,
  input: CreatePrintJobInput,
  number: string,
  ctx: TenantContext,
): Promise<Result<PrintJobData>> {
  try {
    return { ok: true, data: await repo.create(input, number, ctx) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "فشل إنشاء سند الطباعة" };
  }
}

export async function receivePrintJobUseCase(
  repo: IPrintJobRepository,
  input: ReceivePrintJobInput,
  ctx: TenantContext,
): Promise<Result<PrintJobData>> {
  try {
    return { ok: true, data: await repo.receive(input, ctx) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "فشل استلام الطباعة" };
  }
}

export async function listPrintJobsUseCase(
  repo: IPrintJobRepository,
  ctx: TenantContext,
): Promise<Result<PrintJobData[]>> {
  try {
    return { ok: true, data: await repo.list(ctx) };
  } catch (e) {
    return { ok: false, error: "فشل تحميل سندات الطباعة" };
  }
}

export async function listOpenPrintJobsUseCase(
  repo: IPrintJobRepository,
  ctx: TenantContext,
): Promise<Result<PrintJobData[]>> {
  try {
    return { ok: true, data: await repo.listOpen(ctx) };
  } catch (e) {
    return { ok: false, error: "فشل جلب سندات الطباعة قيد العمل" };
  }
}

export async function findPrintJobUseCase(
  repo: IPrintJobRepository,
  id: string,
  ctx: TenantContext,
): Promise<{ ok: true; data: PrintJobData | null } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await repo.findById(id, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل البحث" };
  }
}