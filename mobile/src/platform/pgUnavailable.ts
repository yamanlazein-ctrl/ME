// Replaces backend/src/infrastructure/orm/drizzle.ts on the phone (Metro file mapping). That file opens a
// PostgreSQL pool through `pg`, which the boundary forbids. The shared code reaches it only on its
// `DB_ENGINE=postgres` branches, never taken on the phone (envConfig sets DB_ENGINE = "sqlite"); any use fails loudly.
const unavailable = (what: string): never => {
  throw new Error(`PG_UNAVAILABLE_ON_PHONE: ${what}`);
};

const guarded = (what: string): never =>
  new Proxy(
    {},
    {
      get: () => unavailable(what),
      apply: () => unavailable(what),
    },
  ) as never;

export class TenantScopedPool {
  constructor() {
    unavailable("TenantScopedPool");
  }
}
export const pool = guarded("pool");
export const db = guarded("db");
export const txDb = guarded("txDb");
export const ambientDb = (): never => unavailable("ambientDb");
export const allowLedgerPartyRemap = async (): Promise<void> =>
  unavailable("allowLedgerPartyRemap");
export const withTenantTx = async (): Promise<never> => unavailable("withTenantTx");
export const openDedicatedClient = async (): Promise<never> => unavailable("openDedicatedClient");
export const setTenantForTransaction = async (): Promise<never> =>
  unavailable("setTenantForTransaction");
export const checkDatabase = async (): Promise<boolean> => false;
