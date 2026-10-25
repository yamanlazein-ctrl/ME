// Spike S5 on the device (research R5): enrol against a reachable hub and run the resumable first download, optionally killing
// it at 40 % so a second press proves the resume. Prints counts, per-currency party balance sums and elapsed time; the owner
// compares them with the seed file (scripts/s5-compare.mjs).
import { sql } from "drizzle-orm";
import { getApp } from "../core/appRuntime";
import { enroll, saveEnrollment } from "../core/enrollment";
import { runFirstDownload } from "../core/firstDownload";
import { deviceFirstDownloadDeps } from "../core/firstDownloadDeps";
import { getSecret, setSecret } from "../platform/secureStore";
import { loadDashboard } from "../hooks/useDashboard";

const STARTED_KEY = "s5.startedAt";
const KILLED_KEY = "s5.killed";

export async function runS5(input: {
  hubUrl: string;
  code: string;
  killAt40: boolean;
}): Promise<string[]> {
  const lines: string[] = [];
  const app = await getApp();
  if (!app.enrollment) {
    const enrollment = await enroll(app.runtime, app.conn, {
      hubUrl: input.hubUrl.trim(),
      code: input.code,
    });
    app.attach(enrollment);
    lines.push("S5: enrolled");
  }
  const phone = app.phone;
  if (!phone || !app.enrollment) throw new Error("S5: phone is not enrolled");
  const startedAt = Number((await getSecret(STARTED_KEY)) ?? 0) || Date.now();
  await setSecret(STARTED_KEY, String(startedAt));
  const alreadyKilled = (await getSecret(KILLED_KEY)) === "1";
  const base = deviceFirstDownloadDeps(phone);
  try {
    const result = await runFirstDownload({
      ...base,
      afterPage: async (p) => {
        if (input.killAt40 && !alreadyKilled && p.percent >= 0.4) {
          await setSecret(KILLED_KEY, "1");
          throw new Error("S5_KILLED_AT_40");
        }
      },
    });
    lines.push(`S5: done=${result.done} cursor=${result.cursor}/${result.headSeq}`);
    if (result.done) {
      await saveEnrollment({ ...app.enrollment, firstDownloadDone: true });
      app.enrollment = { ...app.enrollment, firstDownloadDone: true };
      const exec = phone.repos.db as unknown as {
        execute<R>(q: ReturnType<typeof sql>): Promise<{ rows: R[] }>;
      };
      const count = async (table: string) =>
        Number(
          (await exec.execute<{ n: number }>(sql.raw(`SELECT count(*) AS n FROM ${table}`))).rows[0]
            ?.n ?? 0,
        );
      const home = await loadDashboard(phone);
      lines.push(`S5-COUNTS invoices=${await count("invoices")} parties=${await count("parties")}`);
      lines.push(
        `S5-BALANCES receivables=${JSON.stringify(home.receivables)} payables=${JSON.stringify(home.payables)}`,
      );
      lines.push(`S5-ELAPSED-MS ${Date.now() - startedAt}`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    lines.push(
      message === "S5_KILLED_AT_40"
        ? "S5: killed at 40% on purpose - close the app, reopen it and press S5 again"
        : `S5: ERROR ${message}`,
    );
  }
  return lines;
}
