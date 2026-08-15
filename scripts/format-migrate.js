#!/usr/bin/env node
/**
 * One-shot migration: replace all toLocaleString("en-US") with
 * formatMoney / formatNumber / formatQuantity utilities.
 * Handles the three common patterns:
 *   1. Math.round(X).toLocaleString("en-US")   -> formatMoney(X)
 *   2. (X * Y).toLocaleString("en-US")         -> formatNumber(X * Y)
 *   3. n.toLocaleString("en-US")               -> formatNumber(n)
 */
const fs = require("fs");
const path = require("path");

const files = process.argv.slice(2);

const isMoney = (s) =>
  /total|discount|tax|shipping|subtotal|amount|debit|credit|balance|paid|price|remaining|opening|gross|cost/.test(
    s.toLowerCase(),
  );

const isQty = (s) =>
  /quantity|qty|kg|remaining|roll|stock|inventory|gross|width|weight|count|gsm/.test(
    s.toLowerCase(),
  );

const pickFormatter = (leftContext) => {
  if (isMoney(leftContext)) return "formatMoney";
  if (isQty(leftContext)) return "formatQuantity";
  return "formatNumber";
};

files.forEach((file) => {
  let content = fs.readFileSync(file, "utf8");

  // 1. Math.round(X).toLocaleString("en-US") → formatMoney(X)
  content = content.replace(
    /Math\.round\(([^)]+)\)\.toLocaleString\("en-US"\)/g,
    "formatMoney($1)",
  );

  // 2. X.toLocaleString("en-US") where X is not Math.round
  // Find patterns like (expr).toLocaleString("en-US")
  content = content.replace(
    /\b([a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)*)\b\.toLocaleString\("en-US"\)/g,
    (_match, varName) => {
      // Peek a bit left to decide context (very cheap heuristic)
      const idx = content.indexOf(varName + ".toLocaleString");
      const left = content.slice(Math.max(0, idx - 120), idx);
      const fn = pickFormatter(left);
      return `${fn}(${varName})`;
    },
  );

  // 3. (expr).toLocaleString("en-US") with parentheses
  content = content.replace(
    /\(([^)]+)\)\.toLocaleString\("en-US"\)/g,
    (_match, expr) => {
      const idx = content.indexOf("(" + expr + ").toLocaleString");
      const left = content.slice(Math.max(0, idx - 120), idx);
      const fn = pickFormatter(left);
      return `${fn}(${expr})`;
    },
  );

  // 4. Multiline (spread over lines) — handled by the above already covers inline.

  // Add import if not present
  if (/formatNumber|formatMoney|formatQuantity/.test(content)) {
    if (!content.includes('from "@/shared/utils/formatNumber"')) {
      content = content.replace(
        /^(import .+;?)$/m,
        `$1\nimport { formatNumber, formatMoney, formatQuantity } from "@/shared/utils/formatNumber";`,
      );
    }
  }

  fs.writeFileSync(file, content, "utf8");
  console.log("Updated", file);
});
