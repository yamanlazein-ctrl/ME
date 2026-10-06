# Contract: Sync Wire Compatibility (desktop SQLite ↔ central PostgreSQL hub)

The central hub (PostgreSQL) and its HTTP sync API are **unchanged**. The SQLite desktop must be
indistinguishable from the PostgreSQL desktop as seen by the hub.

## Invariants

1. **Push batches**: for the same scenario, the units a SQLite desktop pushes are equal to those of a PostgreSQL desktop
   after canonicalization:
   - JSON keys sorted
   - generated UUIDs mapped through creation order
   - timestamps compared as instants

   The comparison covers the unit kinds, payload fields and types, monetary values (exact), document numbers and block usage.
2. **Pull application**: applying the same pulled units yields identical business tables on both desktop engines.
3. **Monetary values**: serialized from the boundary `number` exactly as today. No string or integer representation
   leaks from SQLite storage (research R5).
4. **Timestamps**: serialized from `Date` exactly as today (ISO UTC).
5. **Cursors**: `sync_state` cursor values (`applied_seq` from the hub) are stored and sent back unchanged.
6. **Conflicts**: the keep-server / rebase / withdraw decisions and the `sync_conflicts` rows behave identically.
7. **Restore on a synced device** (OQ-12):
   - after restore, sync is paused;
   - the device pulls newer hub units automatically;
   - review mode opens only for local post-restore conflicts;
   - outbox units already acknowledged by the hub are never re-pushed (SY-7).

## Verification

A golden test runs the AC-8 A/B scenario twice: PostgreSQL desktops versus the hub, then SQLite desktops versus a fresh hub. The captured traffic
and the final hub state are compared under the canonicalization above, and they must be equal.

**INVESTIGATE (research I-5)**: whether any hub or desktop code hashes jsonb *text*. PostgreSQL jsonb normalizes key
order, while SQLite TEXT preserves insertion order.
