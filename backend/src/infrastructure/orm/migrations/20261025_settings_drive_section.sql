-- Google Drive archive settings section (executes the Drive-archive plan's
-- primary-device decision): the designation of the ONE primary archive device
-- per company is company data, replicated through the hub like every other
-- settings section (PUT /settings/:section → sync unit → replay on all
-- devices), so two devices can never independently become primary.
ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS drive jsonb DEFAULT '{}';
