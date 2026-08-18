import { eq } from "drizzle-orm";
import { db as defaultDb, type DB } from "../orm/drizzle.js";
import type { UUID } from "../../domain/types/index.js";
import type {
  IInstallationStateRepository,
  InstallationStateRow,
  WizardStepName,
} from "../../application/ports/IInstallationStateRepository.js";
import { setupWizardState } from "../orm/schemas/setup-wizard-state.table.js";

type Row = typeof setupWizardState.$inferSelect;

function toRow(r: Row): InstallationStateRow {
  return {
    tenantId: r.tenantId,
    currentStep: r.currentStep as WizardStepName,
    completedSteps: (r.completedSteps ?? []) as WizardStepName[],
    isCompleted: r.isCompleted,
    completedAt: r.completedAt,
    data: (r.data as Record<string, unknown> | null) ?? {},
    updatedAt: r.updatedAt,
  };
}

const WIZARD_ORDER: WizardStepName[] = [
  "welcome",
  "activate",
  "company",
  "localization",
  "admin",
  "review",
  "done",
];

export class PostgresInstallationStateRepository implements IInstallationStateRepository {
  constructor(private readonly db: DB = defaultDb) {}

  async findByTenant(tenantId: UUID): Promise<InstallationStateRow | null> {
    const [row] = await this.db
      .select()
      .from(setupWizardState)
      .where(eq(setupWizardState.tenantId, tenantId))
      .limit(1);
    return row ? toRow(row) : null;
  }

  async create(tenantId: UUID, data: Record<string, unknown> = {}): Promise<InstallationStateRow> {
    const [row] = await this.db
      .insert(setupWizardState)
      .values({ tenantId, currentStep: "welcome", data })
      .returning();
    if (!row) throw new Error("WIZARD_STATE_INSERT_FAILED");
    return toRow(row);
  }

  async saveStep(
    tenantId: UUID,
    step: WizardStepName,
    data: Record<string, unknown> = {},
  ): Promise<InstallationStateRow> {
    const [existing] = await this.db
      .select()
      .from(setupWizardState)
      .where(eq(setupWizardState.tenantId, tenantId))
      .limit(1);
    if (!existing) {
      return this.create(tenantId, { ...data, _pendingStep: step });
    }
    const completed = Array.from(
      new Set<WizardStepName>([...(existing.completedSteps as WizardStepName[]), step]),
    );
    const next = WIZARD_ORDER[Math.min(WIZARD_ORDER.indexOf(step) + 1, WIZARD_ORDER.length - 1)] as WizardStepName;
    // R14: merge step payloads so a later step (e.g. `review`) does not
    // clobber credentials stored by an earlier step (e.g. `admin`).
    const mergedData = { ...(existing.data as Record<string, unknown>), ...data };
    const [updated] = await this.db
      .update(setupWizardState)
      .set({
        currentStep: next,
        completedSteps: completed,
        data: mergedData,
        updatedAt: new Date(),
      })
      .where(eq(setupWizardState.tenantId, tenantId))
      .returning();
    if (!updated) throw new Error("WIZARD_STATE_UPDATE_FAILED");
    return toRow(updated);
  }

  async markCompleted(tenantId: UUID): Promise<InstallationStateRow> {
    const [updated] = await this.db
      .update(setupWizardState)
      .set({
        currentStep: "done",
        isCompleted: true,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(setupWizardState.tenantId, tenantId))
      .returning();
    if (!updated) throw new Error("WIZARD_STATE_NOT_FOUND");
    return toRow(updated);
  }

  async findAnyCompleted(): Promise<UUID | null> {
    const [row] = await this.db
      .select({ tenantId: setupWizardState.tenantId })
      .from(setupWizardState)
      .where(eq(setupWizardState.isCompleted, true))
      .limit(1);
    return row?.tenantId ?? null;
  }

  async reset(tenantId: UUID): Promise<void> {
    await this.db.delete(setupWizardState).where(eq(setupWizardState.tenantId, tenantId));
  }
}
