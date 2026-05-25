/**
 * Bounce events webhook — POST /api/bounce-events.
 *
 * Mechanism is TBD (PRD §17 #2): Cloudflare Email Service may deliver bounce
 * events as a webhook (HTTP POST here), a Worker binding, or a polled API.
 * If it ends up being a binding rather than HTTP, this route just becomes
 * unused — the inbound worker / a separate consumer handles it instead.
 *
 * Behavior (PRD §8.3):
 *   - Match event by provider_message_id → deliveries row.
 *   - Update member: bounce_count++, last_bounce_at = now.
 *   - If permanent (5.x.x) or threshold (≥5 in 30 days) → status='bouncing'.
 *   - audit_log + (rate-limited) admin notification.
 *
 * TODO (Phase 1): implement once Phase-0 question is resolved.
 */

import type { Hono } from "hono";
import type { AppVariables, Env } from "../types.js";

export function mountBounce(app: Hono<{ Bindings: Env; Variables: AppVariables }>): void {
  app.post("/api/bounce-events", async (c) => {
    return c.json({ error: "not implemented (Phase 1; mechanism TBD)" }, 501);
  });
}
