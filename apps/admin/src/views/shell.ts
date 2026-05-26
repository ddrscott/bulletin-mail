import { h, mount } from "../dom.js";
import type { TenantMe } from "../api.js";
import { renderMasthead, renderUserMenu, signOutItem } from "./masthead.js";

/**
 * Render the masthead + empty <main>. Page views fill <main> themselves and
 * are responsible for their own dateline (the per-page breadcrumb under the
 * masthead).
 */
export function renderShell(root: HTMLElement, me: TenantMe, _active: "home" | "group"): void {
  const roleLabel = me.admin.role === "admin" ? "Admin" : "Moderator";

  const userMenu = renderUserMenu({
    email: me.admin.email,
    displayName: me.admin.displayName,
    metaLines: [me.admin.email, `${roleLabel} · ${me.tenant.displayName}`],
    items: [
      { kind: "link", href: "#/profile", label: "Profile" },
      signOutItem(),
    ],
  });

  // On tenant subdomains the tenant IS the brand; "BulletinMail" becomes a
  // mono kicker above the wordmark.
  const masthead = renderMasthead({
    kicker: "BulletinMail",
    title: me.tenant.displayName,
    titleHref: "#/home",
    right: userMenu,
  });

  const dateline = h("div", { class: "dateline dateline--row" },
    h("div", { class: "dateline__nav" },
      h("a", { href: "#/home" }, "Groups"),
      h("span", { class: "sep" }, "·"),
      h("a", { href: "#/team" }, "Team"),
      h("span", { class: "sep" }, "·"),
      h("a", { href: "/" }, "Wiki"),
    ),
  );

  const main = h("main", null);
  mount(root, h("div", { class: "app-shell" }, masthead, dateline, main));
}
