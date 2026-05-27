import { h, mount, fmtDate } from "../dom.js";
import { api, HttpError } from "../api.js";
import type { TenantMe, GroupSummary, PostingPolicy, ReplyToPolicy, ArchiveVisibility } from "../api.js";
import { renderShell } from "./shell.js";

export async function renderHome(root: HTMLElement, me: TenantMe): Promise<void> {
  renderShell(root, me, "home");
  const main = root.querySelector("main")!;
  let groups: GroupSummary[] = [];
  let creating = false;
  let banner: { kind: "ok" | "err"; text: string } | null = null;

  const reload = async () => {
    try {
      groups = (await api.listGroups()).groups;
    } catch (err) {
      banner = { kind: "err", text: `Failed to load groups: ${(err as Error).message}` };
    }
    draw();
  };

  const draw = () => {
    const newGroupBtn = h("button", {
      class: "btn btn--primary",
      onclick: () => { creating = !creating; draw(); },
    }, creating ? "Cancel" : "New group");

    const heading = h("div", { class: "row row--baseline" },
      h("h2", null, me.tenant.displayName),
      h("div", { class: "spacer" }),
      newGroupBtn,
    );

    const sub = h("p", { class: "small muted" },
      `${groups.length} ${groups.length === 1 ? "group" : "groups"}`,
    );

    const sections: (Node | null)[] = [heading, sub, renderWikiCard()];
    if (banner) {
      sections.push(h("div", { class: `banner ${banner.kind === "ok" ? "banner--ok" : "banner--alert"}` }, banner.text));
    }
    if (creating) sections.push(renderCreateForm(me, async (input) => {
      banner = null;
      try {
        const { id } = await api.createGroup(input);
        creating = false;
        banner = { kind: "ok", text: `Created ${input.displayName}.` };
        await reload();
        location.hash = `#/g/${id}`;
      } catch (err) {
        if (err instanceof HttpError && err.status === 409) {
          banner = { kind: "err", text: `A group named "${input.name}" already exists.` };
        } else if (err instanceof HttpError) {
          const p = err.payload as { error?: string; reason?: string } | null;
          banner = { kind: "err", text: `Couldn't create group: ${p?.reason ?? p?.error ?? err.message}` };
        } else {
          banner = { kind: "err", text: `Couldn't create group: ${(err as Error).message}` };
        }
        draw();
      }
    }));

    if (groups.length === 0 && !creating) {
      sections.push(h("div", { class: "panel" },
        h("h3", null, "No groups yet"),
        h("p", { class: "muted" }, "Click ", h("strong", null, "New group"), " above to create your first list."),
      ));
    } else if (groups.length > 0) {
      sections.push(renderTable(me, groups));
    }

    mount(main, h("div", { class: "stack" }, ...sections.filter((s): s is Node => s !== null)));
  };

  draw();
  void reload();
}

function renderWikiCard(): HTMLElement {
  const host = location.host;
  return h("div", { class: "panel" },
    h("div", { class: "row row--baseline" },
      h("h3", { style: { margin: "0" } }, "Tenant wiki"),
      h("div", { class: "spacer" }),
      h("a", { class: "btn", href: "/", target: "_blank", rel: "noopener" }, "Open wiki"),
      h("a", { class: "btn btn--primary", href: "/wiki/index/edit" }, "Edit home page"),
    ),
    h("p", { class: "small muted", style: { margin: "0.5rem 0 0" } },
      "Public landing at ",
      h("a", { href: "/", target: "_blank", rel: "noopener" }, h("code", null, `https://${host}/`)),
      " · Use ",
      h("code", null, "[[Page Name]]"),
      " in any page to create nested pages.",
    ),
  );
}

function renderTable(me: TenantMe, groups: GroupSummary[]): HTMLElement {
  const apex = me.apexDomain;
  return h("div", { class: "table-wrap" }, h("table", { class: "classifieds" },
    h("thead", null, h("tr", null,
      h("th", null, "Group"),
      h("th", null, "Policy"),
      h("th", { class: "num" }, "Members"),
      h("th", null, "Last message"),
    )),
    h("tbody", null,
      ...groups.map((g) => h("tr", null,
        h("td", null,
          h("a", { href: `#/g/${g.id}` }, g.displayName),
          h("div", { class: "mono muted xs" }, `${g.name}@${me.tenant.slug}.${apex}`),
        ),
        h("td", { class: "muted" }, prettyPolicy(g.postingPolicy)),
        h("td", { class: "num mono" }, String(g.activeMemberCount)),
        h("td", { class: "muted" }, fmtDate(g.lastMessageAt)),
      )),
    ),
  ));
}

function renderCreateForm(
  me: TenantMe,
  onSubmit: (input: {
    name: string;
    displayName: string;
    description: string | null;
    postingPolicy: PostingPolicy;
    replyToPolicy: ReplyToPolicy;
    subjectPrefix: string | null;
    archiveVisibility: ArchiveVisibility;
  }) => Promise<void>,
): HTMLElement {
  const apex = me.apexDomain;

  const name = h("input", { type: "text", required: "required", placeholder: "announcements", pattern: "^[a-z][a-z0-9-]*[a-z0-9]$" }) as HTMLInputElement;
  const display = h("input", { type: "text", required: "required", placeholder: "Announcements" }) as HTMLInputElement;
  const description = h("input", { type: "text", placeholder: "Optional description" }) as HTMLInputElement;
  const subjectPrefix = h("input", { type: "text", placeholder: "[Announcements]" }) as HTMLInputElement;
  const policy = h("select", null,
    h("option", { value: "members" }, "Members can post"),
    h("option", { value: "open" }, "Open (anyone can post)"),
    h("option", { value: "moderated" }, "Moderated (admin approves each post)"),
    h("option", { value: "announce_only" }, "Announce only (moderators/sender-only roles)"),
  ) as HTMLSelectElement;
  const replyTo = h("select", null,
    h("option", { value: "list" }, "List (replies go back to everyone)"),
    h("option", { value: "sender" }, "Sender (replies go privately to the author)"),
  ) as HTMLSelectElement;
  const visibility = h("select", null,
    h("option", { value: "members" }, "Members-only"),
    h("option", { value: "none" }, "No archive"),
    h("option", { value: "public" }, "Public (anyone with the URL)"),
  ) as HTMLSelectElement;

  const previewAddr = h("p", { class: "mono muted xs" });
  const previewName = () => {
    const slug = me.tenant.slug;
    const local = name.value.trim() || "your-list";
    previewAddr.textContent = `→ ${local}@${slug}.${apex}`;
  };
  name.addEventListener("input", previewName);
  previewName();

  const submit = h("button", { class: "btn btn--primary", type: "submit" }, "Create group") as HTMLButtonElement;

  return h("form", {
    class: "panel",
    onsubmit: async (ev) => {
      ev.preventDefault();
      const nameVal = name.value.trim().toLowerCase();
      const displayVal = display.value.trim();
      if (!nameVal || !displayVal) return;
      if (visibility.value === "public") {
        if (!confirm("Public archives are visible to anyone with the URL — including search engines. Are you sure?")) return;
      }
      submit.disabled = true;
      await onSubmit({
        name: nameVal,
        displayName: displayVal,
        description: description.value.trim() || null,
        postingPolicy: policy.value as PostingPolicy,
        replyToPolicy: replyTo.value as ReplyToPolicy,
        subjectPrefix: subjectPrefix.value.trim() || null,
        archiveVisibility: visibility.value as ArchiveVisibility,
      });
      submit.disabled = false;
    },
  },
    h("h3", null, "New group"),

    h("div", { class: "field-group" },
      h("label", null, "List name"),
      name,
      previewAddr,
    ),
    h("div", { class: "field-group" },
      h("label", null, "Display name"),
      display,
    ),
    h("div", { class: "field-group" },
      h("label", null, "Description"),
      description,
    ),
    h("div", { class: "field-group" },
      h("label", null, "Who can post?"),
      policy,
    ),
    h("div", { class: "field-group" },
      h("label", null, "Reply-to"),
      replyTo,
    ),
    h("div", { class: "field-group" },
      h("label", null, "Subject prefix"),
      subjectPrefix,
    ),
    h("div", { class: "field-group" },
      h("label", null, "Archive visibility"),
      visibility,
    ),
    submit,
  );
}

function prettyPolicy(p: string): string {
  switch (p) {
    case "members": return "Members can post";
    case "moderated": return "Moderated";
    case "announce_only": return "Announce only";
    case "open": return "Open";
    default: return p;
  }
}
