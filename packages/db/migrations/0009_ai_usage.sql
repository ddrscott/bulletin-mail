-- Per-tenant daily counter for Workers AI generation calls (community hub
-- 5/5). One row per (tenant, UTC day); consumeAiBudget() upserts the row and
-- increments count atomically, refusing the call once the instance-configured
-- cap (ai.dailyGenerationCap) is exceeded. Old rows are tiny and harmless —
-- they double as a coarse usage history for the operator; no cleanup job.
CREATE TABLE ai_usage (
  tenant_id  TEXT NOT NULL,
  day        TEXT NOT NULL,              -- UTC 'YYYY-MM-DD'
  count      INTEGER NOT NULL DEFAULT 0, -- generation calls consumed this day
  PRIMARY KEY (tenant_id, day)
);
