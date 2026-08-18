import type { UUID } from "../../domain/types/index.js";

/**
 * Phase 0 sub-batch 0F — installation state repository port.
 *
 * A single row per tenant, tracking the Initial Setup Wizard's
 * progress. The InstallGate middleware (sub-batch 0F) reads
 * `isCompleted` to decide whether the request can reach the
 * application or must be redirected to /api/setup/*.
 */
export type WizardStepName = "welcome" | "activate" | "company" | "localization" | "admin" | "review" | "done";

export interface InstallationStateRow {
  tenantId: UUID;
  currentStep: WizardStepName;
  completedSteps: WizardStepName[];
  isCompleted: boolean;
  completedAt: Date | null;
  data: Record<string, unknown>;
  updatedAt: Date;
}

export interface IInstallationStateRepository {
  /**
   * Returns the state for a tenant. A fresh tenant (just created)
   * has no row yet — the caller should call `create` to start the
   * wizard.
   */
  findByTenant(tenantId: UUID): Promise<InstallationStateRow | null>;

  /** Create the initial state row (called once after tenant creation). */
  create(tenantId: UUID, data?: Record<string, unknown>): Promise<InstallationStateRow>;

  /** Update the wizard progress. */
  saveStep(
    tenantId: UUID,
    step: WizardStepName,
    data?: Record<string, unknown>,
  ): Promise<InstallationStateRow>;

  /** Mark the wizard complete and record `completedAt`. */
  markCompleted(tenantId: UUID): Promise<InstallationStateRow>;

  /**
   * R13: resolve the bootstrap/primary tenant. Returns the tenant id of
   * the first wizard that has been marked completed, or null if none has
   * finished setup yet. Used by the install gate so it does not depend on
   * a hardcoded/operator-supplied BOOTSTRAP_TENANT_ID.
   */
  findAnyCompleted(): Promise<UUID | null>;

  /** Wipe (used by `Reset` actions, admin only). */
  reset(tenantId: UUID): Promise<void>;
}
