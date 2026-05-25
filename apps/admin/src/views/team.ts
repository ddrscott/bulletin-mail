import { h, mount, fmtDate, gravatarImg } from "../dom.js";
import { api, HttpError } from "../api.js";
import type { TenantMe, TeamMember } from "../api.js";
import { renderShell } from "./shell.js";

export function renderTeam(root: HTMLElement, me: TenantMe): void {
  renderShell(root, me, "home");
  const main = root.querySelector("main")!;
  let team: TeamMember[] = [];
  let banner: { kind: "ok" | "err"; text: string } | null = null;

  const draw = () => {
    const stack = h("div", { class: "stack" });
    stack.appendChild(h("div", { class: "row" },
      h("p", { class: "small muted" }, h("a", { href: "#/home" }, "← Groups")),
    ));
    stack.appendChild(h("h2", null, "Team"));
    stack.appendChild(h("p", { class: "muted small" }, "Admins manage the tenant. Moderators can edit the wiki and approve subscribe requests."));

    if (banner) stack.appendChild(h("div", { class: `banner ${banner.kind === "ok" ? "banner--ok" : "banner--alert"}` }, banner.text));

    stack.appendChild(renderAddForm(async (input) => {
      try {
        await api.addTeamMember(input.email, input.role);
        banner = { kind: "ok", text: `Invited ${input.email} (${input.role}). Sign-in link sent.` };
        await reload();
      } catch (err) {
        if (err instanceof HttpError && err.status === 409) {
          banner = { kind: "err", text: `${input.email} is already on the team.` };
        } else if (err instanceof HttpError && err.status === 403) {
          banner = { kind: "err", text: "Only admins can add team members." };
        } else {
          banner = { kind: "err", text: `Failed: ${(err as Error).message}` };
        }
        draw();
      }
    }));

    stack.appendChild(renderTable(team, me, onRoleChange, onRemove));
    mount(main, stack);
  };

  const reload = async () => {
    try {
      team = (await api.listTeam()).team;
    } catch (err) {
      banner = { kind: "err", text: `Failed to load team: ${(err as Error).message}` };
    }
    draw();
  };

  const onRoleChange = async (m: TeamMember, role: "admin" | "moderator") => {
    try {
      await api.updateTeamRole(m.id, role);
      banner = { kind: "ok", text: `${m.email} is now ${role}.` };
      await reload();
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        banner = { kind: "err", text: "Can't demote the only admin." };
      } else if (err instanceof HttpError && err.status === 403) {
        banner = { kind: "err", text: "Only admins can change roles." };
      } else {
        banner = { kind: "err", text: `Failed: ${(err as Error).message}` };
      }
      draw();
    }
  };

  const onRemove = async (m: TeamMember) => {
    if (m.id === me.admin.id) {
      banner = { kind: "err", text: "You can't remove yourself." };
      draw();
      return;
    }
    if (!confirm(`Remove ${m.email}? They'll lose access immediately.`)) return;
    try {
      await api.removeTeamMember(m.id);
      banner = { kind: "ok", text: `Removed ${m.email}.` };
      await reload();
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        banner = { kind: "err", text: "Can't remove the only admin." };
      } else if (err instanceof HttpError && err.status === 403) {
        banner = { kind: "err", text: "Only admins can remove team members." };
      } else {
        banner = { kind: "err", text: `Failed: ${(err as Error).message}` };
      }
      draw();
    }
  };

  draw();
  void reload();
}

function renderAddForm(onAdd: (input: { email: string; role: "admin" | "moderator" }) => Promise<void>): HTMLElement {
  const email = h("input", { type: "email", required: "required", placeholder: "mod@church.org" }) as HTMLInputElement;
  const role = h("select", null,
    h("option", { value: "moderator" }, "Moderator (wiki + subscribe pending)"),
    h("option", { value: "admin" }, "Admin (full control + can promote)"),
  ) as HTMLSelectElement;
  const submit = h("button", { class: "btn btn--primary", type: "submit" }, "Invite") as HTMLButtonElement;

  return h("form", {
    class: "panel",
    onsubmit: async (ev) => {
      ev.preventDefault();
      const value = email.value.trim();
      if (!value) return;
      submit.disabled = true;
      await onAdd({ email: value, role: role.value as "admin" | "moderator" });
      email.value = "";
      role.value = "moderator";
      submit.disabled = false;
    },
  },
    h("h3", null, "Invite team member"),
    h("div", { class: "row" }, email, role, submit),
    h("p", { class: "hint" }, "A sign-in link is emailed immediately. They can sign in at this tenant's URL."),
  );
}

function renderTable(
  team: TeamMember[],
  me: TenantMe,
  onRoleChange: (m: TeamMember, role: "admin" | "moderator") => void,
  onRemove: (m: TeamMember) => void,
): HTMLElement {
  if (team.length === 0) return h("div", { class: "empty" }, "Loading team…");
  return h("div", { class: "panel" }, h("div", { class: "table-wrap" }, h("table", null,
    h("thead", null, h("tr", null,
      h("th", { class: "avatar-cell" }, ""),
      h("th", null, "Email"),
      h("th", null, "Role"),
      h("th", null, "Added"),
      h("th", null, ""),
    )),
    h("tbody", null, ...team.map((m) => h("tr", null,
      h("td", { class: "avatar-cell" }, gravatarImg(m.email)),
      h("td", null,
        m.email,
        m.id === me.admin.id ? h("span", { class: "small muted" }, "  (you)") : null,
      ),
      h("td", null, renderRoleSelect(m, me, onRoleChange)),
      h("td", { class: "small muted" }, fmtDate(m.createdAt)),
      h("td", null, m.id === me.admin.id
        ? null
        : h("button", { class: "btn small", onclick: () => onRemove(m) }, "Remove"),
      ),
    ))),
  )));
}

function renderRoleSelect(
  m: TeamMember,
  _me: TenantMe,
  onRoleChange: (m: TeamMember, role: "admin" | "moderator") => void,
): HTMLElement {
  return h("select", {
    onchange: (ev) => {
      const role = (ev.target as HTMLSelectElement).value as "admin" | "moderator";
      onRoleChange(m, role);
    },
  },
    h("option", { value: "moderator", ...(m.role === "moderator" ? { selected: "selected" } : {}) }, "Moderator"),
    h("option", { value: "admin", ...(m.role === "admin" ? { selected: "selected" } : {}) }, "Admin"),
  );
}
