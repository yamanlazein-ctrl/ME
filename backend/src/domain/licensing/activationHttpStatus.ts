/**
 * Shared activation failure → HTTP status mapping (Phase 2).
 * Used by License Server `/v1/activate` and ERP `/api/setup/wizard/activate`
 * so clients see consistent codes.
 */

export type ActivationHttpMapping = {
  status: number;
  code: string;
  message: string;
};

/** Stable machine codes → HTTP status. */
export const ACTIVATION_HTTP_STATUS: Readonly<Record<string, number>> = {
  INVALID_LICENSE: 400,
  LICENSE_NOT_FOUND: 400,
  LICENSE_EXPIRED: 400,
  LICENSE_SUSPENDED: 403,
  LICENSE_REVOKED: 403,
  ALREADY_ACTIVE: 409,
  DEVICE_LIMIT: 409,
  DEVICE_LIMIT_REACHED: 409,
  FINGERPRINT_MISMATCH: 409,
  ACTIVATION_FAILED: 400,
  VALIDATION_ERROR: 422,
};

/**
 * Map an activation error string (or Error.message) to HTTP status + code.
 */
export function mapActivationError(
  error: unknown,
  fallbackMessage = "فشل التفعيل",
): ActivationHttpMapping {
  const msg =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : fallbackMessage;
  const code = msg.trim() || "ACTIVATION_FAILED";
  const status =
    ACTIVATION_HTTP_STATUS[code] ?? (code.startsWith("INVALID") ? 400 : 500);
  return {
    status,
    code,
    message: status === 500 && code === msg ? fallbackMessage : code === msg ? code : msg,
  };
}

/**
 * Map a setup/activate use-case failure (`{ code?, error }`) to HTTP fields.
 * Prefers machine `code` for status; keeps human `error` as the response message.
 */
export function mapActivationFailure(result: {
  code?: string;
  error?: string;
}): ActivationHttpMapping {
  const mapped = mapActivationError(result.code ?? "ACTIVATION_FAILED");
  const human = result.error?.trim();
  return {
    status: mapped.status,
    code: mapped.code,
    message: human || mapped.message,
  };
}
