ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS number varchar(32);
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS received_at timestamptz;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS result_fabric_id uuid;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS result_color_id uuid;
