/**
 * #/profile — edit your own display name. Works on both site-admin and
 * tenant-admin hosts; the API endpoint is host-aware.
 *
 * Paints its own minimal app-shell so it doesn't depend on the site/tenant
 * shell renderers having been called first.
 */

import { h, mount, gravatarImg } from "../dom.js";
import { api, HttpError } from "../api.js";
import type { Me } from "../api.js";

export function renderProfile(root: HTMLElement, me: Me): void {
  const isTenant = me.kind === "tenant";
  const email = isTenant ? me.admin.email : me.siteAdmin.email;
  let currentName = isTenant ? me.admin.displayName : me.siteAdmin.displayName;
  const roleLabel = isTenant
    ? (me.admin.role === "admin" ? "Tenant admin" : "Moderator")
    : "Site admin";
  const scope = isTenant ? me.tenant.displayName : "BulletinMail instance";
  const backHref = isTenant ? "#/home" : "#/";

  let banner: { kind: "ok" | "err"; text: string } | null = null;

  const draw = () => {
    const nameInput = h("input", {
      type: "text",
      value: currentName ?? "",
      placeholder: "Leave empty to fall back to Gravatar",
      maxlength: "120",
    }) as HTMLInputElement;

    const submit = h("button", { class: "btn btn--primary", type: "submit" }, "Save") as HTMLButtonElement;
    const reset = h("button", { class: "btn", type: "button" }, "Clear (use Gravatar)") as HTMLButtonElement;
    reset.addEventListener("click", () => { nameInput.value = ""; nameInput.focus(); });

    const form = h("form", {
      onsubmit: async (ev) => {
        ev.preventDefault();
        const value = nameInput.value.trim();
        submit.disabled = true;
        try {
          const res = await api.updateProfile(value || null);
          currentName = res.displayName;
          banner = {
            kind: "ok",
            text: res.displayName
              ? `Saved. You're now shown as "${res.displayName}".`
              : "Saved. Display name cleared — falling back to Gravatar.",
          };
        } catch (err) {
          banner = {
            kind: "err",
            text: err instanceof HttpError
              ? `Couldn't save: ${err.message}`
              : `Couldn't save: ${(err as Error).message}`,
          };
        } finally {
          submit.disabled = false;
          draw();
        }
      },
    },
      h("div", { class: "field-group" },
        h("label", null, "Display name"),
        nameInput,
        h("p", { class: "hint" }, "Shown wherever your email currently appears in the admin UI. Members and other admins will see this name."),
      ),
      h("div", { class: "row" }, submit, reset),
    );

    const card = h("div", { class: "panel" },
      h("div", { class: "row" },
        gravatarImg(email, 64),
        h("div", null,
          h("h3", { style: { margin: "0" } }, currentName ?? email),
          h("p", { class: "small muted", style: { margin: "0.25rem 0 0" } },
            email, " · ", roleLabel, " · ", scope,
          ),
        ),
      ),
    );

    const masthead = h("header", { class: "masthead masthead--tenant" },
      h("h1", { class: "wordmark wordmark--with-kicker" },
        h("span", { class: "wordmark__kicker" }, "Bulletinmail"),
        h("a", { href: backHref }, isTenant ? me.tenant.displayName : "Site admin"),
      ),
    );

    const dateline = h("p", { class: "dateline" },
      h("a", { href: backHref }, "← Back"),
      h("span", { class: "sep" }, "·"),
      "Profile",
    );

    const main = h("main", null);
    const stack = h("div", { class: "stack" });
    stack.appendChild(h("h2", null, "Profile"));
    if (banner) {
      stack.appendChild(h("div", { class: `banner ${banner.kind === "ok" ? "banner--ok" : "banner--alert"}` }, banner.text));
    }
    stack.appendChild(card);
    stack.appendChild(h("div", { class: "panel" }, h("h3", null, "Edit"), form));
    mount(main, stack);

    mount(root, h("div", { class: "app-shell" }, masthead, dateline, main));
  };

  draw();
}
