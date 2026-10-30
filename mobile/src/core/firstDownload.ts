// First download (FR-07, research R5): the hub has no bootstrap endpoint (501 stubs), so a new phone replays the hub's stream
// with the existing pull loop from the stored cursor. The shared pull persists the cursor after every page, so the loop
// resumes after a kill. Progress is cursor ÷ headSeq.
export class InsufficientStorageError extends Error {
  constructor(
    readonly neededBytes: number,
    readonly freeBytes: number,
  ) {
    super(`INSUFFICIENT_STORAGE needed=${neededBytes} free=${freeBytes}`);
    this.name = "InsufficientStorageError";
  }
}

export const BYTES_PER_UNIT_ESTIMATE = 2 * 1024; // E15: headSeq × 2 KB

export interface FirstDownloadProgress {
  /** 0..1 */
  percent: number;
  /** Units applied during this run. */
  applied: number;
  cursor: number;
  headSeq: number;
}

export interface PullPageResult {
  pulled: number;
  applied: number;
  failed: number;
  deviceTrust?: { code: string; message: string } | null;
}

export interface FirstDownloadDeps {
  /** The hub's current stream head. */
  headSeq(): Promise<number>;
  /** The persisted pull cursor (0 the first time). */
  cursor(): Promise<number>;
  /** One shared pull page; advances the persisted cursor. */
  pullPage(): Promise<PullPageResult>;
  freeDiskBytes(): Promise<number>;
  onProgress?(progress: FirstDownloadProgress): void;
  /** Called after each page; throwing here simulates a kill (S5 "kill at 40%"). */
  afterPage?(progress: FirstDownloadProgress): void | Promise<void>;
}

export interface FirstDownloadResult {
  done: boolean;
  applied: number;
  cursor: number;
  headSeq: number;
  stoppedBy?: "deviceTrust" | "failed" | "stalled";
}

// The shared pull parks a unit that cannot apply after 5 attempts (one per page) and only then lets the stream pass,
// so the first download must outlast that budget instead of giving up first.
const MAX_STALLED_PAGES = 7;

export async function runFirstDownload(deps: FirstDownloadDeps): Promise<FirstDownloadResult> {
  const headSeq = await deps.headSeq();
  let cursor = await deps.cursor();
  const needed = Math.max(0, headSeq - cursor) * BYTES_PER_UNIT_ESTIMATE;
  const free = await deps.freeDiskBytes();
  if (needed > free) throw new InsufficientStorageError(needed, free);

  let applied = 0;
  let stalled = 0;
  for (;;) {
    const page = await deps.pullPage();
    applied += page.applied;
    const nextCursor = await deps.cursor();
    const moved = nextCursor > cursor;
    cursor = nextCursor;
    const progress: FirstDownloadProgress = {
      percent: headSeq > 0 ? Math.min(1, cursor / headSeq) : 1,
      applied,
      cursor,
      headSeq,
    };
    deps.onProgress?.(progress);
    await deps.afterPage?.(progress);
    if (page.deviceTrust)
      return { done: false, applied, cursor, headSeq, stoppedBy: "deviceTrust" };
    if (page.pulled === 0) return { done: true, applied, cursor, headSeq };
    if (page.failed > 0 && !moved) {
      stalled += 1;
      if (stalled >= MAX_STALLED_PAGES)
        return { done: false, applied, cursor, headSeq, stoppedBy: "failed" };
    } else if (!moved && page.applied === 0) {
      stalled += 1;
      if (stalled >= MAX_STALLED_PAGES)
        return { done: false, applied, cursor, headSeq, stoppedBy: "stalled" };
    } else {
      stalled = 0;
    }
  }
}
