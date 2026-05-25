import { h, mount, currentApex } from "../dom.js";
import { api } from "../api.js";
import type { TenantMe, GroupSummary } from "../api.js";
import { renderShell } from "./shell.js";
import { renderMembersTab } from "./members.js";
import { renderSettingsTab } from "./settings.js";
import { renderPendingTab } from "./pending.js";

export async function renderGroup(root: HTMLElement, me: TenantMe, groupId: string): Promise<void> {
  renderShell(root, me, "group");
  const main = root.querySelector("main")!;
  mount(main, h("div", { class: "empty" }, "Loading group…"));

  let group: GroupSummary | undefined;
  try {
    const { groups } = await api.listGroups();
    group = groups.find((g) => g.id === groupId);
  } catch (err) {
    mount(main, h("div", { class: "banner banner--alert" }, `Failed to load group: ${(err as Error).message}`));
    return;
  }
  if (!group) {
    mount(main, h("div", { class: "panel" },
      h("h3", null, "Group not found"),
      h("p", { class: "muted" }, "It may have been removed, or the link is mistyped."),
      h("p", null, h("a", { href: "#/home" }, "← Back to groups")),
    ));
    return;
  }

  const apex = currentApex();
  const header = h("div", { class: "group-header" },
    h("p", { class: "dateline" },
      h("a", { href: "#/home" }, "Groups"),
      h("span", { class: "sep" }, "·"),
      group.name,
    ),
    h("h2", null, group.displayName),
    h("p", { class: "group-id" }, `${group.name}@${me.tenant.slug}.${apex}`),
    h("p", { class: "small muted" },
      h("span", { class: "stamp" }, `${group.activeMemberCount} members`),
    ),
  );

  const tabContent = h("div", null);
  const tabs = h("div", { class: "tabs" });

  const tabSpec = [
    { key: "members",   label: "Members",          render: () => renderMembersTab(tabContent, group!) },
    { key: "pending",   label: "Pending",          render: () => renderPendingTab(tabContent, group!, () => { /* members tab re-renders on next switch */ }) },
    { key: "settings",  label: "Settings",         render: () => renderSettingsTab(tabContent, group!, () => {
      header.querySelector("h2")!.textContent = group!.displayName;
    }) },
    { key: "messages",  label: "Recent messages",  render: () => stubTab(tabContent, "Recent messages — coming in slice 3.") },
    { key: "moderation",label: "Moderation",       render: () => stubTab(tabContent, "Moderation queue — coming in slice 4.") },
  ];

  let active = "members";
  const setActive = (key: string) => {
    active = key;
    for (const child of Array.from(tabs.children)) child.classList.remove("active");
    const idx = tabSpec.findIndex((t) => t.key === key);
    tabs.children[idx]!.classList.add("active");
    tabSpec[idx]!.render();
  };

  for (const t of tabSpec) {
    tabs.appendChild(h("button", { class: "tab", onclick: () => setActive(t.key) }, t.label));
  }

  mount(main, h("div", null, header, tabs, tabContent));
  setActive(active);
}

function stubTab(host: HTMLElement, msg: string): void {
  mount(host, h("div", { class: "empty" }, msg));
}
