/**
 * Load Testing Script for Fabric ERP API
 * ============================================================
 * Uses k6 (https://k6.io) for realistic load testing.
 *
 * Install:  brew install k6    (macOS) or    apt-get install k6 (Linux)
 * Run:      k6 run --env BASE_URL=http://localhost:3000 --env API_KEY=xxx load-test.js
 *
 * Scenarios:
 *   1. Statement query (كشف حساب) — the most expensive endpoint
 *   2. Invoice list (filtered by party)
 *   3. Authentication (login + refresh)
 *   4. Dashboard KPI (cash + sales today)
 *
 * Expected thresholds (after Phase 1 indexes):
 *   - Statement: < 200ms p95, < 500ms p99
 *   - Invoice list: < 50ms p95
 *   - Dashboard: < 100ms p95
 */

import http from "k6/http";
import { check, sleep, group } from "k6";
import { Rate, Trend } from "k6/metrics";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const API_KEY = __ENV.API_KEY || "";
const TENANT_ID = __ENV.TENANT_ID || "demo-tenant";
const DURATION = __ENV.DURATION || "30s";

const statementLatency = new Trend("statement_latency");
const invoiceListLatency = new Trend("invoice_list_latency");
const dashboardLatency = new Trend("dashboard_latency");
const errorRate = new Rate("errors");

// ---------------------------------------------------------------------------
// Test options — ramp up to realistic load
// ---------------------------------------------------------------------------
export const options = {
  stages: [
    { duration: "10s", target: 10 }, // Warm-up: 10 virtual users
    { duration: "20s", target: 50 }, // Ramp up: 50 concurrent users
    { duration: "30s", target: 100 }, // Peak: 100 concurrent users
    { duration: "10s", target: 0 }, // Cool down
  ],
  thresholds: {
    // Phase 1 targets after indexes
    statement_latency: ["p(95)<200", "p(99)<500"],
    invoice_list_latency: ["p(95)<50"],
    dashboard_latency: ["p(95)<100"],
    errors: ["rate<0.01"], // < 1% error rate
    http_req_duration: ["p(95)<200"],
  },
};

// ---------------------------------------------------------------------------
// Setup — authenticate once per VU
// ---------------------------------------------------------------------------
export function setup() {
  const loginRes = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({
      email: __ENV.TEST_EMAIL || "admin@fabric-erp.test",
      password: __ENV.TEST_PASSWORD || "testpass123",
    }),
    {
      headers: { "Content-Type": "application/json" },
    },
  );

  check(loginRes, {
    "login status is 200": (r) => r.status === 200,
  });

  return { token: loginRes.json("token"), tenantId: TENANT_ID };
}

// ---------------------------------------------------------------------------
// Main test flow
// ---------------------------------------------------------------------------
export default function (data) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${data.token}`,
    "X-Tenant-Id": data.tenantId,
  };

  // --- Scenario 1: Statement query (كشف حساب) ---
  group("Statement (كشف حساب)", () => {
    const start = Date.now();
    // Simulate statement for a party with 50,000 ledger rows
    const res = http.get(
      `${BASE_URL}/api/statements?partyId=${__ENV.TEST_PARTY_ID || "demo-party"}&fromDate=2020-01-01&toDate=2024-12-31&currency=SYP&limit=100&offset=0`,
      { headers },
    );
    statementLatency.add(Date.now() - start);
    const ok = check(res, {
      "statement status is 200": (r) => r.status === 200,
      "statement has data": (r) => r.json("data") !== undefined,
    });
    errorRate.add(!ok);
  });

  sleep(Math.random() * 2);

  // --- Scenario 2: Invoice list ---
  group("Invoice list", () => {
    const start = Date.now();
    const res = http.get(
      `${BASE_URL}/api/invoices?partyId=${__ENV.TEST_PARTY_ID || "demo-party"}&status=active&limit=20`,
      { headers },
    );
    invoiceListLatency.add(Date.now() - start);
    const ok = check(res, {
      "invoice list status is 200": (r) => r.status === 200,
      "invoice list has data": (r) => r.json("data") !== undefined,
    });
    errorRate.add(!ok);
  });

  sleep(Math.random() * 2);

  // --- Scenario 3: Dashboard KPI ---
  group("Dashboard KPI", () => {
    const start = Date.now();
    const res = http.get(`${BASE_URL}/api/dashboard/today?currency=SYP`, { headers });
    dashboardLatency.add(Date.now() - start);
    const ok = check(res, {
      "dashboard status is 200": (r) => r.status === 200,
    });
    errorRate.add(!ok);
  });

  sleep(Math.random() * 2);
}
