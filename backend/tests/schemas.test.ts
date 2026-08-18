import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  tenants,
  licenses,
  licenseActivations,
  deviceRegistrations,
  licenseAuditEvents,
  secrets,
  companyProfiles,
  setupWizardState,
  serverInstallations,
} from "@/infrastructure/orm/schemas";

/**
 * Phase 0 sub-batch 0A — schema tests.
 *
 * These tests verify:
 *  1. The 8 new tables are importable from the schema barrel.
 *  2. The tenants table has the 6 new columns added by 0A.
 *  3. The 0002_platform_foundation.sql migration exists and contains
 *     the expected DDL, RLS policies, partial unique index, and
 *     append-only trigger for license_audit_events.
 *  4. The journal marks 0001_initial and 0002_platform_foundation.
 *  5. The snapshot (0002_snapshot.json) is present and parseable.
 */
describe("Phase 0 — Platform Foundation schemas (sub-batch 0A)", () => {
  describe("schema exports", () => {
    it("exports all 8 new tables from the barrel", () => {
      expect(licenses).toBeDefined();
      expect(licenseActivations).toBeDefined();
      expect(deviceRegistrations).toBeDefined();
      expect(licenseAuditEvents).toBeDefined();
      expect(secrets).toBeDefined();
      expect(companyProfiles).toBeDefined();
      expect(setupWizardState).toBeDefined();
      expect(serverInstallations).toBeDefined();
    });

    it("exports the extended tenants table", () => {
      expect(tenants).toBeDefined();
    });
  });

  describe("tenants extension", () => {
    it("has the 6 new licensing columns", () => {
      // Drizzle exposes column names as object properties; we can assert
      // their presence (a runtime sanity check, not a type check).
      const cols = tenants as unknown as Record<string, { name: string }>;
      expect(cols.licenseStatus).toBeDefined();
      expect(cols.licenseType).toBeDefined();
      expect(cols.maxDevices).toBeDefined();
      expect(cols.activationId).toBeDefined();
      expect(cols.serverFingerprint).toBeDefined();
      expect(cols.lastHeartbeatAt).toBeDefined();
    });

    it("preserves the original license_key and license_expires_at columns", () => {
      const cols = tenants as unknown as Record<string, { name: string }>;
      expect(cols.licenseKey).toBeDefined();
      expect(cols.licenseExpiresAt).toBeDefined();
    });
  });

  describe("0002_platform_foundation.sql migration", () => {
    const migrationsDir = join(
      process.cwd(),
      "src",
      "infrastructure",
      "orm",
      "migrations",
    );
    const migrationPath = join(migrationsDir, "0002_platform_foundation.sql");
    const journalPath = join(migrationsDir, "meta", "_journal.json");
    const snapshotPath = join(migrationsDir, "meta", "0002_snapshot.json");

    it("exists on disk", () => {
      expect(existsSync(migrationPath)).toBe(true);
    });

    it("contains the 8 new CREATE TABLE statements", () => {
      const sql = readFileSync(migrationPath, "utf8");
      for (const t of [
        "licenses",
        "license_activations",
        "device_registrations",
        "license_audit_events",
        "secrets",
        "company_profiles",
        "setup_wizard_state",
        "server_installations",
      ]) {
        expect(sql).toContain(`CREATE TABLE "${t}"`);
      }
    });

    it("extends the tenants table with the 6 new columns", () => {
      const sql = readFileSync(migrationPath, "utf8");
      for (const c of [
        "license_status",
        "license_type",
        "max_devices",
        "activation_id",
        "server_fingerprint",
        "last_heartbeat_at",
      ]) {
        expect(sql).toMatch(new RegExp(`ALTER TABLE "tenants" ADD COLUMN[^\\n]*"${c}"`));
      }
    });

    it("enables + forces RLS on every new table", () => {
      const sql = readFileSync(migrationPath, "utf8");
      for (const t of [
        "licenses",
        "license_activations",
        "device_registrations",
        "license_audit_events",
        "secrets",
        "company_profiles",
        "setup_wizard_state",
        "server_installations",
      ]) {
        expect(sql).toMatch(
          new RegExp(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`),
        );
        expect(sql).toMatch(
          new RegExp(`ALTER TABLE "${t}" FORCE  ROW LEVEL SECURITY`),
        );
      }
    });

    it("declares policies with both USING and WITH CHECK on every new table", () => {
      const sql = readFileSync(migrationPath, "utf8");
      for (const t of [
        "licenses",
        "license_activations",
        "device_registrations",
        "license_audit_events",
        "secrets",
        "company_profiles",
        "setup_wizard_state",
        "server_installations",
      ]) {
        const re = new RegExp(
          `CREATE POLICY "${t}_tenant_isolation" ON "${t}"[\\s\\S]+?USING[\\s\\S]+?WITH CHECK`,
        );
        expect(sql).toMatch(re);
      }
    });

    it("creates the partial unique index for one-active-activation-per-license", () => {
      const sql = readFileSync(migrationPath, "utf8");
      expect(sql).toContain(
        `CREATE UNIQUE INDEX "idx_license_activations_one_active"`,
      );
      expect(sql).toContain(`WHERE "deactivated_at" IS NULL`);
    });

    it("installs the append-only trigger on license_audit_events", () => {
      const sql = readFileSync(migrationPath, "utf8");
      expect(sql).toContain(
        `CREATE OR REPLACE FUNCTION "fn_license_audit_events_append_only"`,
      );
      expect(sql).toMatch(
        /CREATE TRIGGER "trg_license_audit_events_no_update"/,
      );
      expect(sql).toMatch(
        /CREATE TRIGGER "trg_license_audit_events_no_delete"/,
      );
    });
  });

  describe("drizzle journal + snapshot", () => {
    const metaDir = join(
      process.cwd(),
      "src",
      "infrastructure",
      "orm",
      "migrations",
      "meta",
    );
    const journalPath = join(metaDir, "_journal.json");
    const snapshotPath = join(metaDir, "0002_snapshot.json");

    it("journal marks 0001_initial as already applied (when: 0)", () => {
      const j = JSON.parse(readFileSync(journalPath, "utf8"));
      const e0 = j.entries.find((e: { tag: string }) => e.tag === "0001_initial");
      expect(e0).toBeDefined();
      expect(e0.when).toBe(0);
    });

    it("journal records 0002_platform_foundation as the second migration", () => {
      const j = JSON.parse(readFileSync(journalPath, "utf8"));
      const e1 = j.entries.find(
        (e: { tag: string }) => e.tag === "0002_platform_foundation",
      );
      expect(e1).toBeDefined();
      expect(e1.idx).toBe(1);
    });

    it("snapshot exists and is valid JSON", () => {
      expect(existsSync(snapshotPath)).toBe(true);
      const s = JSON.parse(readFileSync(snapshotPath, "utf8"));
      // Drizzle snapshots are versioned objects — at minimum they have
      // a `version` field. The shape evolves; do not over-couple.
      expect(typeof s).toBe("object");
      expect(s).not.toBeNull();
    });
  });
});
