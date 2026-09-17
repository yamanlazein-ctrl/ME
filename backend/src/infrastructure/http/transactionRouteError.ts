import type { Response } from "express";
import { BusinessRuleError, DayLockedError } from "../../domain/errors/index.js";
import {
  persistenceErrorMessage,
  transactionFailureMessage,
  type PersistenceContext,
} from "../errors/persistenceErrorMessage.js";

export function respondTransactionFailure(
  res: Response,
  err: unknown,
  context: PersistenceContext,
  syncFallback: string,
  syncCode = "SYNC_OUTBOX_FAILED",
): void {
  const message = transactionFailureMessage(err, context, syncFallback);
  const status = err instanceof BusinessRuleError || err instanceof DayLockedError ? 422 : 500;
  res.status(status).json({
    code: status === 422 ? "VALIDATION" : syncCode,
    message,
    statusCode: status,
  });
}

export { persistenceErrorMessage };
