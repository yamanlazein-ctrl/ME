// The phone application core: one database connection, the repositories, the document services and the sync cycle,
// for one enrolled user. UI code talks to this object only.
import type { TenantContext } from "@backend/domain/types/index";
import { buildPhoneRepositories, type PhoneRepositories } from "./container";
import { createDocuments, type Documents } from "./documents";
import { closeRuntime, type PhoneRuntime } from "./runtime";
import { runPhoneSyncCycle, type SyncCycleResult } from "./syncCycle";

export interface PhoneUser {
  id: string;
  name: string;
  role: TenantContext["userRole"];
}

export interface PhoneIdentity {
  tenantId: string;
  syncDeviceId: string;
  user: PhoneUser;
}

export interface Phone {
  runtime: PhoneRuntime;
  repos: PhoneRepositories;
  documents: Documents;
  identity: PhoneIdentity;
  setUser(user: PhoneUser): void;
  context(): TenantContext;
  syncOnce(options?: { budgetMs?: number }): Promise<SyncCycleResult>;
  close(): void;
}

/** `runtime` comes from `openRuntime(conn)` (src/core/runtime.ts), which runs before enrolment. */
export function createPhone(runtime: PhoneRuntime, identity: PhoneIdentity): Phone {
  const repos = buildPhoneRepositories();
  const state = { identity };
  const context = (): TenantContext => ({
    tenantId: state.identity.tenantId,
    userId: state.identity.user.id,
    userRole: state.identity.user.role,
    userName: state.identity.user.name,
    syncDeviceId: state.identity.syncDeviceId,
  });
  const documents = createDocuments({ repos, context });
  return {
    runtime,
    repos,
    documents,
    get identity() {
      return state.identity;
    },
    setUser(user) {
      state.identity = { ...state.identity, user };
    },
    context,
    syncOnce: (options) =>
      runPhoneSyncCycle({
        repos,
        context,
        ...(options?.budgetMs ? { budgetMs: options.budgetMs } : {}),
      }),
    close: () => closeRuntime(runtime),
  };
}
