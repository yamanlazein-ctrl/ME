// The session service of the running app (session.ts wired to the enrolled hub and the local outbox).
import { resolveHubAuthHeader } from "@backend/application/use-cases/sync/hubConfig";
import { getApp } from "./appRuntime";
import { createSessionService, deviceSessionDeps, type SessionService } from "./session";

let service: SessionService | null = null;

export async function getSessionService(): Promise<SessionService> {
  if (service) return service;
  const app = await getApp();
  service = createSessionService(
    deviceSessionDeps({
      hubUrl: () => app.enrollment?.hubUrl ?? "",
      tenantId: () => app.enrollment?.tenantId ?? "",
      deviceAuthHeader: async () => (await resolveHubAuthHeader()) ?? undefined,
      pendingCount: async () =>
        app.phone
          ? app.phone.repos.syncOutboxRepo.countOutstanding(app.phone.identity.tenantId as never)
          : 0,
    }),
  );
  return service;
}

export function resetSessionService(): void {
  service = null;
}
