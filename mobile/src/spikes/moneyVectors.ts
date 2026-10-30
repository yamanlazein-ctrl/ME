import vectors from "@erp/shared/money-vectors.json";
import { moneyVectorPasses, type MoneyVector } from "@erp/shared/moneyVectorsRunner";

export interface MoneyVectorsResult {
  passed: number;
  total: number;
  failedIds: string[];
}

/** Runs packages/shared/src/money-vectors.json through the real functions on this JavaScript engine (Hermes). */
export function runMoneyVectorsHere(): MoneyVectorsResult {
  const all = vectors as MoneyVector[];
  const failedIds = all.filter((v) => !moneyVectorPasses(v)).map((v) => v.id);
  return { passed: all.length - failedIds.length, total: all.length, failedIds };
}
