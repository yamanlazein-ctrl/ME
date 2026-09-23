-- A stale-replay refusal can legitimately have NO base version (the payload carried none) or no
-- readable server version. recordSyncConflict() already models both as `number | null`; the
-- NOT NULL constraints made the refusal path itself crash instead of recording the conflict.
ALTER TABLE sync_conflicts ALTER COLUMN base_version DROP NOT NULL;
ALTER TABLE sync_conflicts ALTER COLUMN server_version DROP NOT NULL;
