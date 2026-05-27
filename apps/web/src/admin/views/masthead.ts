/**
 * Shared masthead + user-menu helpers.
 *
 * Every admin view that renders the page chrome (tenant shell, site-admin
 * home, profile sub-page) uses the same masthead grid (auto 1fr auto) with
 * the wordmark on the left and an optional element in the right column.
 * For signed-in views that right element is the user menu (avatar +
 * dropdown); for nested sub-pages it can be a back link or nothing.
 *
 * The wiki shell renders server-side via HTML strings and has its own
 * parallel implementation; the CSS class names below are the contract that
 * keeps them visually identical.
 */

import { h, gravatarImg } from "../dom.js";
import { api } from "../api.js";

export type MastheadOptions = {
  /** Small mono kicker above the title. Omit for plain wordmark variant. */
  kicker?: string;
  /** The wordmark text. Always present. */
  title: string;
  /** Optional href the title links to. */
  titleHref?: string;
  /** Element to render in the right column (typically the user menu). */
  right?: Node | null;
};

export function renderMasthead(opts: MastheadOptions): HTMLElement {
  const titleNode = opts.titleHref
    ? h("a", { href: opts.titleHref }, opts.title)
    : document.createTextNode(opts.title);

  const wordmarkClass = opts.kicker ? "wordmark wordmark--with-kicker" : "wordmark";
  const wordmark = opts.kicker
    ? h("h1", { class: wordmarkClass },
        h("span", { class: "wordmark__kicker" }, opts.kicker),
        titleNode,
      )
    : h("h1", { class: wordmarkClass }, titleNode);

  const headerClass = opts.kicker ? "masthead masthead--tenant" : "masthead";
  const header = h("header", { class: headerClass }, wordmark);
  if (opts.right) header.appendChild(opts.right);
  return header;
}

export type UserMenuItem =
  | { kind: "link"; href: string; label: string }
  | { kind: "section"; label: string }
  | { kind: "action"; label: string; onClick: () => void | Promise<void>; danger?: boolean };

export type UserMenuOptions = {
  email: string;
  displayName: string | null;
  /** Secondary lines under the name, in order. e.g., ["Site admin"] or ["Admin · Acme"]. */
  metaLines: string[];
  /** Items rendered in the dropdown panel. */
  items: UserMenuItem[];
};

/**
 * Build the user menu `<details>` element. The caller is responsible for
 * attaching it (typically as the `right` slot of renderMasthead). Outside-
 * click close is wired up automatically.
 */
export function renderUserMenu(opts: UserMenuOptions): HTMLDetailsElement {
  const triggerLabel = opts.displayName ?? opts.email;

  const meta = h("div", { class: "user-menu__meta" },
    h("strong", null, opts.displayName ?? opts.email),
    ...opts.metaLines.flatMap((line) => [h("br", null), line] as Node[]),
  );

  const itemNodes: Node[] = opts.items.map((item) => {
    if (item.kind === "section") {
      return h("div", { class: "user-menu__section" }, item.label);
    }
    if (item.kind === "link") {
      return h("a", { class: "user-menu__item", href: item.href }, item.label);
    }
    return h("button", {
      class: "user-menu__item" + (item.danger ? " user-menu__item--danger" : ""),
      type: "button",
      onclick: (ev: MouseEvent) => {
        ev.preventDefault();
        void item.onClick();
      },
    }, item.label);
  });

  const menu = h("details", { class: "user-menu" },
    h("summary", { class: "user-menu__trigger", "aria-label": triggerLabel },
      gravatarImg(opts.email, 24),
      h("span", { class: "user-menu__caret", "aria-hidden": "true" }, "▾"),
    ),
    h("div", { class: "user-menu__panel", role: "menu" }, meta, ...itemNodes),
  ) as HTMLDetailsElement;

  document.addEventListener("click", (ev) => {
    if (!menu.contains(ev.target as Node)) menu.removeAttribute("open");
  });

  return menu;
}

/** Convenience: a sign-out action that posts to the API and reloads. */
export function signOutItem(): UserMenuItem {
  return {
    kind: "action",
    label: "Sign out",
    danger: true,
    onClick: async () => {
      try { await api.signout(); } catch {}
      location.hash = "";
      location.reload();
    },
  };
}
