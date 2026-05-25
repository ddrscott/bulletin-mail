import { h, mount, gravatarImg } from "../dom.js";
import { api } from "../api.js";
import type { TenantMe } from "../api.js";

/**
 * Render the masthead + empty <main>. Page views fill <main> themselves and
 * are responsible for their own dateline (the per-page breadcrumb under the
 * masthead).
 */
export function renderShell(root: HTMLElement, me: TenantMe, _active: "home" | "group"): void {
  // On tenant subdomains the tenant IS the brand; "Bulletinmail" is a small
  // kicker above. Reduces visual weight on mobile too — the page H2 is
  // already the tenant name and we don't need a 32px wordmark fighting it.
  const masthead = h("header", { class: "masthead masthead--tenant" },
    h("h1", { class: "wordmark wordmark--with-kicker" },
      h("span", { class: "wordmark__kicker" }, "Bulletinmail"),
      h("a", { href: "#/home" }, me.tenant.displayName),
    ),
  );

  const roleLabel = me.admin.role === "admin" ? "Admin" : "Moderator";

  const signOutBtn = h("button", {
    class: "user-menu__item user-menu__item--danger",
    type: "button",
    onclick: async (ev: MouseEvent) => {
      ev.preventDefault();
      try { await api.signout(); } catch {}
      location.hash = "";
      location.reload();
    },
  }, "Sign out");

  const userMenu = h("details", { class: "user-menu" },
    h("summary", {
      class: "user-menu__trigger",
      "aria-label": me.admin.displayName || me.admin.email,
    },
      gravatarImg(me.admin.email, 24),
      h("span", { class: "user-menu__caret", "aria-hidden": "true" }, "▾"),
    ),
    h("div", { class: "user-menu__panel", role: "menu" },
      h("div", { class: "user-menu__meta" },
        h("strong", null, me.admin.displayName ?? me.admin.email),
        h("br", null),
        me.admin.email,
        h("br", null),
        roleLabel, " · ", me.tenant.displayName,
      ),
      h("a", { class: "user-menu__item", href: "#/profile" }, "Profile"),
      signOutBtn,
    ),
  );

  const dateline = h("div", { class: "dateline dateline--row" },
    h("div", { class: "dateline__nav" },
      h("a", { href: "#/home" }, "Groups"),
      h("span", { class: "sep" }, "·"),
      h("a", { href: "#/team" }, "Team"),
      h("span", { class: "sep" }, "·"),
      h("a", { href: "/" }, "Wiki"),
    ),
    userMenu,
  );

  // Close the user menu on outside click.
  document.addEventListener("click", (ev) => {
    if (!userMenu.contains(ev.target as Node)) userMenu.removeAttribute("open");
  });

  const main = h("main", null);
  mount(root, h("div", { class: "app-shell" }, masthead, dateline, main));
}
