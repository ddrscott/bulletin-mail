import { h, mount, gravatarImg } from "../dom.js";
import { api, HttpError } from "../api.js";
import type { GroupSummary, Member } from "../api.js";

export function renderMembersTab(host: HTMLElement, group: GroupSummary): void {
  let members: Member[] = [];
  let banner: { kind: "ok" | "err"; text: string } | null = null;

  const draw = () => {
    const root = h("div", { class: "stack" });

    if (banner) {
      root.appendChild(h("div", { class: `banner ${banner.kind === "ok" ? "banner--ok" : "banner--alert"}` }, banner.text));
    }

    root.appendChild(renderAddForm(async (input) => {
      banner = null;
      try {
        await api.addMember(group.id, input);
        banner = { kind: "ok", text: `Added ${input.email}.` };
        await reload();
      } catch (err) {
        if (err instanceof HttpError && err.status === 409) {
          banner = { kind: "err", text: `${input.email} is already a member.` };
        } else if (err instanceof HttpError && err.status === 400) {
          banner = { kind: "err", text: "Invalid email address." };
        } else {
          banner = { kind: "err", text: `Failed to add: ${(err as Error).message}` };
        }
        draw();
      }
    }));

    root.appendChild(renderBulkCard(group, () => { reload(); }));

    if (members.length === 0) {
      root.appendChild(h("div", { class: "empty" }, "No members yet."));
    } else {
      root.appendChild(renderTable(members, onRoleChange, onRemove));
    }

    mount(host, root);
  };

  const reload = async () => {
    try {
      members = (await api.listMembers(group.id)).members;
    } catch (err) {
      banner = { kind: "err", text: `Failed to load members: ${(err as Error).message}` };
    }
    draw();
  };

  const onRoleChange = async (m: Member, role: Member["role"]) => {
    banner = null;
    try {
      await api.updateRole(group.id, m.id, role);
      banner = { kind: "ok", text: `${m.email}: role is now ${role}.` };
      await reload();
    } catch (err) {
      banner = { kind: "err", text: `Failed to update role: ${(err as Error).message}` };
      draw();
    }
  };

  const onRemove = async (m: Member) => {
    if (!confirm(`Remove ${m.email}? They'll be marked unsubscribed and stop receiving mail.`)) return;
    banner = null;
    try {
      await api.removeMember(group.id, m.id);
      banner = { kind: "ok", text: `${m.email} unsubscribed.` };
      await reload();
    } catch (err) {
      banner = { kind: "err", text: `Failed to remove: ${(err as Error).message}` };
      draw();
    }
  };

  draw();
  reload();
}

function renderAddForm(onAdd: (input: { email: string; displayName?: string; role: Member["role"] }) => Promise<void>): HTMLElement {
  const email = h("input", { type: "email", placeholder: "alice@example.com", required: "required" }) as HTMLInputElement;
  const name = h("input", { type: "text", placeholder: "Display name (optional)" }) as HTMLInputElement;
  const role = h("select", null,
    h("option", { value: "member" }, "Member"),
    h("option", { value: "moderator" }, "Moderator"),
    h("option", { value: "sender_only" }, "Sender only"),
  ) as HTMLSelectElement;
  const submit = h("button", { class: "btn btn--primary", type: "submit" }, "Add member") as HTMLButtonElement;

  const form = h("form", {
    class: "panel",
    onsubmit: async (ev) => {
      ev.preventDefault();
      const value = email.value.trim();
      if (!value) return;
      submit.disabled = true;
      const input: { email: string; displayName?: string; role: Member["role"] } = {
        email: value,
        role: role.value as Member["role"],
      };
      if (name.value.trim()) input.displayName = name.value.trim();
      await onAdd(input);
      submit.disabled = false;
      email.value = ""; name.value = ""; role.value = "member";
      email.focus();
    },
  },
    h("h3", null, "Add a member"),
    h("div", { class: "row" }, email, name, role, submit),
  );
  return form;
}

function renderBulkCard(group: GroupSummary, onAfterCommit: () => void): HTMLElement {
  const textarea = h("textarea", { placeholder: "Paste emails (one per line, comma-separated, or 'Name <email>' format)" }) as HTMLTextAreaElement;
  const preview = h("div", { class: "small muted" }, "Type or paste, then click Preview.");
  const commitBtn = h("button", { class: "btn btn--primary", disabled: "disabled" }, "Add all") as HTMLButtonElement;
  let pending: string[] = [];

  const previewBtn = h("button", {
    class: "btn",
    onclick: async () => {
      const csv = textarea.value;
      if (!csv.trim()) return;
      try {
        const { toAdd, duplicates, invalid, total } = await api.bulkPreview(group.id, csv);
        pending = toAdd;
        mount(preview, h("div", { class: "stack stack--tight" },
          h("p", { class: "small" },
            `${total} address${total === 1 ? "" : "es"} found · `,
            h("span", { class: "stamp" }, `${toAdd.length} to add`),
            ` `,
            h("span", { class: "stamp stamp--quiet" }, `${duplicates.length} already members`),
            invalid.length > 0 ? [` `, h("span", { class: "stamp stamp--alert" }, `${invalid.length} invalid`)] : null,
          ),
          toAdd.length > 0 ? h("details", null,
            h("summary", { class: "small" }, `${toAdd.length} new`),
            h("ul", { class: "small muted" }, ...toAdd.slice(0, 50).map((e) => h("li", { class: "mono" }, e))),
          ) : null,
          invalid.length > 0 ? h("details", null,
            h("summary", { class: "small danger" }, "Invalid"),
            h("ul", { class: "small muted" }, ...invalid.slice(0, 50).map((e) => h("li", { class: "mono" }, e))),
          ) : null,
        ));
        commitBtn.disabled = toAdd.length === 0;
      } catch (err) {
        mount(preview, h("div", { class: "banner banner--alert" }, `Preview failed: ${(err as Error).message}`));
        commitBtn.disabled = true;
      }
    },
  }, "Preview") as HTMLButtonElement;

  commitBtn.addEventListener("click", async () => {
    if (pending.length === 0) return;
    commitBtn.disabled = true;
    try {
      const { added, skipped } = await api.bulkCommit(group.id, pending);
      mount(preview, h("div", { class: "banner banner--ok" }, `Added ${added.length}; skipped ${skipped.length} (already members).`));
      textarea.value = "";
      pending = [];
      onAfterCommit();
    } catch (err) {
      mount(preview, h("div", { class: "banner banner--alert" }, `Commit failed: ${(err as Error).message}`));
      commitBtn.disabled = false;
    }
  });

  return h("details", { class: "panel" },
    h("summary", null, "Bulk import (paste emails)"),
    h("div", { class: "panel-body stack" },
      textarea,
      h("div", { class: "row" }, previewBtn, commitBtn),
      preview,
    ),
  );
}

function renderTable(
  members: Member[],
  onRoleChange: (m: Member, role: Member["role"]) => void,
  onRemove: (m: Member) => void,
): HTMLElement {
  return h("div", { class: "table-wrap" }, h("table", { class: "classifieds" },
    h("thead", null, h("tr", null,
      h("th", { class: "avatar-cell" }, ""),
      h("th", null, "Email"),
      h("th", null, "Name"),
      h("th", null, "Role"),
      h("th", null, "Status"),
      h("th", null, ""),
    )),
    h("tbody", null, ...members.map((m) => h("tr", null,
      h("td", { class: "avatar-cell" }, gravatarImg(m.email)),
      h("td", { class: "mono" }, m.email),
      h("td", { class: "muted" }, m.displayName ?? ""),
      h("td", null, renderRoleSelect(m, onRoleChange)),
      h("td", null, renderStatusStamp(m)),
      h("td", null, m.status === "active"
        ? h("button", { class: "btn btn--small", onclick: () => onRemove(m) }, "Remove")
        : null),
    ))),
  ));
}

function renderRoleSelect(m: Member, onRoleChange: (m: Member, role: Member["role"]) => void): HTMLElement {
  const select = h("select", {
    onchange: (ev) => {
      const target = ev.target as HTMLSelectElement;
      onRoleChange(m, target.value as Member["role"]);
    },
  },
    h("option", { value: "member", ...(m.role === "member" ? { selected: "selected" } : {}) }, "Member"),
    h("option", { value: "moderator", ...(m.role === "moderator" ? { selected: "selected" } : {}) }, "Moderator"),
    h("option", { value: "sender_only", ...(m.role === "sender_only" ? { selected: "selected" } : {}) }, "Sender only"),
  );
  if (m.status !== "active") select.setAttribute("disabled", "disabled");
  return select;
}

function renderStatusStamp(m: Member): HTMLElement {
  if (m.status === "active")               return h("span", { class: "stamp" }, "Active");
  if (m.status === "bouncing")             return h("span", { class: "stamp stamp--alert" }, `Bouncing · ${m.bounceCount}`);
  if (m.status === "pending_confirmation") return h("span", { class: "stamp stamp--quiet" }, "Awaiting confirmation");
  return h("span", { class: "stamp stamp--quiet" }, "Unsubscribed");
}
