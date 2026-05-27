/**
 * Site-admin home view (app.<apex>). Lists every tenant on the instance
 * and provides a "Create tenant" form. Creating a tenant pre-fills the
 * first tenant-admin email; the API sends a magic link to that address
 * pointing at the tenant subdomain so the new admin can immediately sign
 * in there.
 *
 * Visual vocabulary mirrors shell.ts (masthead + dateline + <main>) so the
 * site-admin shell reads as a sibling of the tenant-admin shell.
 */

import { h, mount, fmtDate, currentApex } from "../dom.js";
import { api, HttpError } from "../api.js";
import type { SiteMe } from "../api.js";
import { renderMasthead, renderUserMenu, signOutItem } from "./masthead.js";

export function renderSiteHome(root: HTMLElement, me: SiteMe): void {
  let tenants = me.tenants;
  let creating = false;
  let banner: { kind: "ok" | "err"; text: string } | null = null;

  const reload = async () => {
    try {
      const fresh = await api.me();
      if (fresh.kind === "site") tenants = fresh.tenants;
    } catch (err) {
      banner = { kind: "err", text: `Failed to reload: ${(err as Error).message}` };
    }
    draw();
  };

  const draw = () => {
    const apex = currentApex();

    const userMenu = renderUserMenu({
      email: me.siteAdmin.email,
      displayName: me.siteAdmin.displayName,
      metaLines: [me.siteAdmin.email, "Site admin"],
      items: [
        { kind: "link", href: "#/profile", label: "Profile" },
        signOutItem(),
      ],
    });

    const masthead = renderMasthead({
      title: "BulletinMail",
      titleHref: "/",
      right: userMenu,
    });

    const dateline = h("div", { class: "dateline dateline--row" },
      h("div", { class: "dateline__nav" }, "Site admin"),
    );

    const heading = h("div", { class: "row row--baseline" },
      h("h2", null, "Tenants"),
      h("div", { class: "spacer" }),
      h("button", {
        class: "btn btn--primary",
        onclick: () => { creating = !creating; draw(); },
      }, creating ? "Cancel" : "New tenant"),
    );

    const sub = h("p", { class: "small muted" },
      `${tenants.length} ${tenants.length === 1 ? "tenant" : "tenants"} on this instance`,
    );

    const sections: (Node | null)[] = [heading, sub];
    if (banner) {
      sections.push(h("div", { class: `banner ${banner.kind === "ok" ? "banner--ok" : "banner--alert"}` }, banner.text));
    }
    if (creating) sections.push(renderCreateForm(apex, async (input) => {
      banner = null;
      try {
        const result = await api.createTenant(input);
        banner = {
          kind: "ok",
          text: `Created ${result.tenant.displayName}. Sign-in link sent to ${input.adminEmail}.`,
        };
        creating = false;
        await reload();
      } catch (err) {
        if (err instanceof HttpError) {
          const p = err.payload as { error?: string; reason?: string } | null;
          if (err.status === 409) banner = { kind: "err", text: "That slug is already taken." };
          else banner = { kind: "err", text: `Failed: ${p?.reason ?? p?.error ?? err.message}` };
        } else {
          banner = { kind: "err", text: `Failed: ${(err as Error).message}` };
        }
        draw();
      }
    }));

    if (tenants.length === 0 && !creating) {
      sections.push(h("div", { class: "panel" },
        h("h3", null, "No tenants yet"),
        h("p", { class: "muted" }, "Click ", h("strong", null, "New tenant"), " to provision the first one."),
      ));
    } else if (tenants.length > 0) {
      sections.push(renderTable(apex, tenants));
    }

    const main = h("main", null);
    mount(main, h("div", { class: "stack" }, ...sections.filter((s): s is Node => s !== null)));
    mount(root, h("div", { class: "app-shell" }, masthead, dateline, main));
  };

  draw();
}

function renderTable(apex: string, tenants: SiteMe["tenants"]): HTMLElement {
  return h("div", { class: "panel" }, h("div", { class: "table-wrap" }, h("table", null,
    h("thead", null, h("tr", null,
      h("th", null, "Tenant"),
      h("th", null, "Slug"),
      h("th", null, "Plan"),
      h("th", null, "Status"),
      h("th", null, "Created"),
    )),
    h("tbody", null, ...tenants.map((t) => h("tr", null,
      h("td", null,
        h("a", { href: `https://${t.slug}.${apex}/admin/`, target: "_blank", rel: "noopener" }, t.displayName),
      ),
      h("td", { class: "small muted" }, t.slug),
      h("td", { class: "small muted" }, t.plan),
      h("td", { class: "small " + (t.status === "active" ? "ok" : "warn") }, t.status),
      h("td", { class: "small muted" }, fmtDate(t.createdAt)),
    ))),
  )));
}

function renderCreateForm(
  apex: string,
  onSubmit: (input: { slug: string; displayName: string; adminEmail: string }) => Promise<void>,
): HTMLElement {
  const slug = h("input", { type: "text", required: "required", placeholder: "firstpresby", pattern: "^[a-z][a-z0-9-]+[a-z0-9]$" }) as HTMLInputElement;
  const displayName = h("input", { type: "text", required: "required", placeholder: "First Presbyterian" }) as HTMLInputElement;
  const adminEmail = h("input", { type: "email", required: "required", placeholder: "pastor@firstpresby.org" }) as HTMLInputElement;
  const submit = h("button", { class: "btn btn--primary", type: "submit" }, "Create + email admin") as HTMLButtonElement;

  const preview = h("p", { class: "hint" });
  const updatePreview = () => {
    const s = slug.value.trim() || "<slug>";
    preview.textContent = `→ https://${s}.${apex}/admin/ · sign-in link emailed to ${adminEmail.value.trim() || "the address above"}`;
  };
  slug.addEventListener("input", updatePreview);
  adminEmail.addEventListener("input", updatePreview);
  updatePreview();

  return h("form", {
    class: "panel",
    onsubmit: async (ev) => {
      ev.preventDefault();
      submit.disabled = true;
      await onSubmit({
        slug: slug.value.trim().toLowerCase(),
        displayName: displayName.value.trim(),
        adminEmail: adminEmail.value.trim(),
      });
      submit.disabled = false;
    },
  },
    h("h3", null, "New tenant"),
    h("div", { class: "field-group" },
      h("label", null, "Slug (becomes the subdomain)"),
      slug,
    ),
    h("div", { class: "field-group" },
      h("label", null, "Display name"),
      displayName,
    ),
    h("div", { class: "field-group" },
      h("label", null, "First admin email"),
      adminEmail,
    ),
    preview,
    submit,
  );
}
