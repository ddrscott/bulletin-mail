/**
 * Admin SPA entry. Host-aware:
 *   - On app.<apex>  /api/me returns `kind: "site"`  → site-admin view
 *   - On <tenant>.<apex>/admin /api/me returns `kind: "tenant"` → tenant views
 *
 * Hash router for tenant context:
 *   ""  or  "#/"  or  "#/home"  → groups list
 *   "#/g/<id>"                    → group detail
 *   "#/team"                      → moderator promotion UI
 */

import { api, HttpError } from "./api.js";
import type { Me, TenantMe } from "./api.js";
import { renderSignIn } from "./views/signin.js";
import { renderSiteHome } from "./views/site-home.js";
import { renderHome } from "./views/home.js";
import { renderGroup } from "./views/group.js";
import { renderTeam } from "./views/team.js";
import { renderProfile } from "./views/profile.js";

const root = document.getElementById("app")!;
let me: Me | null = null;

async function boot(): Promise<void> {
  try {
    me = await api.me();
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) {
      renderSignIn(root);
      return;
    }
    root.replaceChildren(`Failed to load: ${(err as Error).message}`);
    return;
  }

  // Hash routing for both contexts. Most routes are tenant-only; #/profile
  // works on either host (the API endpoint is host-aware).
  if (me.kind === "site" && !location.hash) location.hash = "#/";
  if (me.kind === "tenant" && !location.hash) location.hash = "#/home";
  await dispatch();
}

async function dispatch(): Promise<void> {
  if (!me) return;
  const hash = location.hash || "#/";

  // Shared routes (any context).
  if (hash === "#/profile") return renderProfile(root, me);

  if (me.kind === "site") {
    return renderSiteHome(root, me);
  }

  // Tenant routes.
  const tenantMe: TenantMe = me;
  if (hash === "#/" || hash === "#/home") return renderHome(root, tenantMe);
  if (hash === "#/team") return renderTeam(root, tenantMe);
  const groupMatch = hash.match(/^#\/g\/([A-Za-z0-9_-]+)$/);
  if (groupMatch) return renderGroup(root, tenantMe, groupMatch[1]!);
  location.hash = "#/home";
}

window.addEventListener("hashchange", () => { void dispatch(); });
void boot();
