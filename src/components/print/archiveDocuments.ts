/**
 * The archive document builders live in `@erp/shared` — ONE implementation, used by the local
 * print path (here) and by the Drive archive (the backend, which builds the same documents).
 *
 * This module re-exports them so the frontend's import paths stay stable.
 */
export * from "@erp/shared";
