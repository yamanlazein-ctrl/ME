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
  /**
   * The company name for the Drive root folder, read when the archive needs it (not at boot), so a
   * name change in Settings is picked up. Null or blank falls back to the product name.
   */
  companyName?: () => Promise<string | null>;
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
  const folders = new FolderOrganizer(db, client, opts.companyName);
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
  };
  return {
    deps,
    router: createDriveRouter({
      // The getters are copied BY HAND: `{...deps}` would evaluate `driveClient` ONCE, at wiring
      // time — when no token has been pushed yet — and freeze it to null for the life of the
      // process. The live client must stay live.
      get db() {
        return deps.db;
      },
      get queue() {
        return deps.queue;
      },
      get localDeviceId() {
        return deps.localDeviceId;
      },
      get driveClient() {
        return deps.driveClient;
      },
      // The run continues in the BACKGROUND: the route answers with its id straight away, and the
      // client polls the progress. The route must not await the pass — it can take minutes.
      startArchiveRun: async (trigger, periodKey) => {
        let resolveRun: ((id: string | null) => void) | null = null;
        let skipped: string | null = null;
        const runId = new Promise<string | null>((resolve) => {
          resolveRun = resolve;
        });
        const done = runArchivePass(deps, trigger, {
          periodKey,
          onRun: (id) => resolveRun?.(id),
        });
        void done
          .then((report) => {
            // A run that skipped before it started has no id; say WHY, so the client can tell
            // "busy" from "not connected" from "nothing to do" instead of a silent no-op.
            skipped = report.skipped;
            if (!report.runId) resolveRun?.(null);
          })
          .catch((err) => {
            logger.error({ err }, "DRIVE_ARCHIVE_RUN_FAILED");
            resolveRun?.(null);
          });
        const id = await Promise.race([
          runId,
          new Promise<null>((r) => setTimeout(() => r(null), 5_000)),
        ]);
        return { runId: id, skipped };
      },
    }),
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
