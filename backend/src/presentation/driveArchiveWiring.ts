/**
 * Google Drive archive wiring for the desktop (SQLite) backend — the one place that builds the
 * production client, queue, router and worker, used by server.ts and by the end-to-end test.
 *
 * Token flow (D-01): the Rust shell holds the refresh token and pushes short-lived access tokens to
 * `POST /api/desktop/runtime/drive-token`; `liveDriveToken` serves them to this client. The device
 * identity (D-05) is the installation id the shell passes as MOTARD_INSTALLATION_ID — the id the
 * primary-device designation names.
 */
import { logger } from "../infrastructure/config/logger.js";

export type DriveArchiveWiringOptions = {
  /** The gated SQLite handle (a raw write inside a business transaction would roll back with it). */
  db: unknown;
  localDeviceId: string | null;
  /** Google API base URL; tests point it at a local fake. */
  baseUrl?: string;
};

export async function wireDriveArchive(opts: DriveArchiveWiringOptions) {
  const { createDriveRouter } = await import("./routes/drive.route.js");
  const { UploadQueue } = await import("../infrastructure/googledrive/uploadQueue.js");
  const { FolderOrganizer } = await import("../infrastructure/googledrive/folderOrganizer.js");
  const { Exporters } = await import("../infrastructure/googledrive/exporters.js");
  const { DriveClient, liveDriveToken, liveDriveTokenAvailable, onLiveDriveConnected } =
    await import("../infrastructure/googledrive/driveClient.js");
  const { startDriveArchiveWorker, runArchivePass } =
    await import("../infrastructure/googledrive/monthlyArchiveJob.js");

  const db = opts.db as never;
  const client = new DriveClient({ token: liveDriveToken, baseUrl: opts.baseUrl });
  const folders = new FolderOrganizer(db, client);
  const queue = new UploadQueue(db, client, folders);
  const exporters = new Exporters(db);
  const deps = {
    db,
    queue,
    folders,
    exporters,
    localDeviceId: opts.localDeviceId,
    get driveClient() {
      return liveDriveTokenAvailable() ? client : null;
    },
    get drive() {
      return liveDriveTokenAvailable() ? client : null;
    },
    syncNow: async () => {
      const r = await runArchivePass(deps, "manual");
      return { queued: r.enqueued, started: r.processed > 0 };
    },
  };
  return {
    deps,
    router: createDriveRouter(deps),
    /** The 6-hour worker, plus a pass as soon as the shell's first token arrives. */
    start() {
      startDriveArchiveWorker(deps);
      onLiveDriveConnected(() => {
        void runArchivePass(deps, "connect").catch((err) =>
          logger.error({ err }, "DRIVE_ARCHIVE_CONNECT_PASS_FAILED"),
        );
      });
    },
  };
}
