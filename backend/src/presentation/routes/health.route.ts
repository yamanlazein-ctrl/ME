import { Router, type Request, type Response } from "express";
import { db } from "../../infrastructure/orm/drizzle.js";
import { sql } from "drizzle-orm";

export function registerHealthRoutes(
  router: Router,
  checkDatabase: () => Promise<boolean>,
  checkRedis: () => Promise<boolean>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rbac: any,
) {
  router.get("/api/health/live", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  router.get("/api/health/ready", async (_req, res) => {
    const dbOk = await checkDatabase();
    const redisOk = await checkRedis();

    if (dbOk && redisOk) {
      res.status(200).json({ status: "ready", checks: { database: true, redis: true } });
    } else {
      res.status(503).json({
        status: "not_ready",
        checks: { database: dbOk, redis: redisOk },
      });
    }
  });

  /**
   * Deep health check — comprehensive system status.
   * Returns: database latency, memory, uptime, version.
   * Used by: monitoring dashboards, alerting systems, deployment validation.
   */
  router.get("/api/health/deep", rbac(["admin"]), async (_req: Request, res: Response) => {
    const start = Date.now();
    const checks: Record<string, { status: string; details?: string; ms?: number }> = {};

    // 1. Database check with latency
    try {
      const dbStart = Date.now();
      await db.execute(sql`SELECT 1`);
      checks.database = { status: "ok", ms: Date.now() - dbStart };
    } catch (e) {
      checks.database = { status: "error", details: e instanceof Error ? e.message : "unknown" };
    }

    // 2. Redis check
    try {
      const redisOk = await checkRedis();
      checks.redis = { status: redisOk ? "ok" : "error" };
    } catch (e) {
      checks.redis = { status: "error", details: e instanceof Error ? e.message : "unknown" };
    }

    // 3. Memory check
    try {
      const mem = process.memoryUsage();
      const heapUsed = Math.round(mem.heapUsed / 1024 / 1024);
      const heapTotal = Math.round(mem.heapTotal / 1024 / 1024);
      const rss = Math.round(mem.rss / 1024 / 1024);
      checks.memory = {
        status: heapUsed > heapTotal * 0.9 ? "warning" : "ok",
        details: `RSS: ${rss}MB, Heap: ${heapUsed}/${heapTotal}MB`,
      };
    } catch {
      checks.memory = { status: "unknown", details: "check failed" };
    }

    // 4. Disk check (Linux/Unix only)
    try {
      if (process.platform !== "win32") {
        const { execSync } = await import("child_process");
        const df = execSync("df -h / | tail -1", { encoding: "utf-8" }).trim();
        const parts = df.split(/\s+/);
        const usage = parseInt(parts[4].replace("%", ""), 10);
        checks.disk = {
          status: usage > 90 ? "warning" : usage > 80 ? "caution" : "ok",
          details: `${usage}% used`,
        };
      } else {
        checks.disk = { status: "ok", details: "check not available on Windows" };
      }
    } catch {
      checks.disk = { status: "unknown", details: "check failed" };
    }

    // 5. Database size check
    try {
      const sizeResult = await db.execute(sql`
        SELECT pg_size_pretty(pg_database_size(current_database())) as size
      `);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      checks.databaseSize = {
        status: "ok",
        details: (sizeResult.rows[0] as any)?.size ?? "unknown",
      };
    } catch {
      checks.databaseSize = { status: "unknown", details: "check failed" };
    }

    // 6. Timestamp
    checks.timestamp = { status: "ok", details: new Date().toISOString() };

    const totalMs = Date.now() - start;
    const hasError = Object.values(checks).some(
      (c) => c.status === "error" || c.status === "warning",
    );
    const statusCode = hasError ? 503 : 200;

    res.status(statusCode).json({
      status: hasError ? "degraded" : "healthy",
      uptime: process.uptime(),
      responseTime: totalMs,
      checks,
      version: process.env.npm_package_version || "unknown",
      environment: process.env.NODE_ENV || "development",
    });
  });
}
