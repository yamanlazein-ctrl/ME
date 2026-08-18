import type { EndpointMeta, ApiError } from "./_shared";
import type { UUID } from "@/domain/types";
import type {
  PrintJobDTO,
  CreatePrintSendInput,
  ReceivePrintInput,
} from "@/application/ports/IPrintJobRepository";

export type { PrintJobDTO, CreatePrintSendInput, ReceivePrintInput };

export type ListPrintJobsResponse = PrintJobDTO[];
export type ListPrintJobsError = ApiError;
export const ListPrintJobsEndpoint: EndpointMeta = {
  path: "/api/printing",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "List all print jobs",
};

export type ListOpenPrintJobsResponse = PrintJobDTO[];
export type ListOpenPrintJobsError = ApiError;
export const ListOpenPrintJobsEndpoint: EndpointMeta = {
  path: "/api/printing/open",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "List open (not yet received) print jobs",
};

export type GetPrintJobResponse = PrintJobDTO;
export type GetPrintJobError = ApiError & { code: "NOT_FOUND" };
export const GetPrintJobEndpoint: EndpointMeta = {
  path: "/api/printing/:id",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "Get print job by ID",
};

export type CreatePrintSendResponse = PrintJobDTO;
export type CreatePrintSendError = ApiError & { code: "VALIDATION_ERROR" | "NOT_FOUND" };
export const CreatePrintSendEndpoint: EndpointMeta = {
  path: "/api/printing/send",
  method: "POST",
  auth: { required: true, roles: ["admin", "warehouse"] },
  description: "Send fabric to printing press",
};

export type ReceivePrintResponse = PrintJobDTO;
export type ReceivePrintError = ApiError & {
  code: "NOT_FOUND" | "VALIDATION_ERROR" | "INVALID_STATE";
};
export const ReceivePrintEndpoint: EndpointMeta = {
  path: "/api/printing/receive",
  method: "POST",
  auth: { required: true, roles: ["admin", "warehouse"] },
  description: "Receive printed fabric back from press",
};
