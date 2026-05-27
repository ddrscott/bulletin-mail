import { h, mount } from "../dom.js";
import { api, HttpError } from "../api.js";
import type { GroupSummary, PostingPolicy, ReplyToPolicy, ArchiveVisibility, UpdateGroupInput } from "../api.js";

export function renderSettingsTab(host: HTMLElement, group: GroupSummary, onSaved: () => void): void {
  let banner: { kind: "ok" | "err"; text: string } | null = null;

  const draw = () => {
    const display = h("input", { type: "text", required: "required", value: group.displayName }) as HTMLInputElement;
    const description = h("input", { type: "text", value: group.description ?? "" }) as HTMLInputElement;
    const subjectPrefix = h("input", { type: "text", value: group.subjectPrefix ?? "", placeholder: "(no prefix)" }) as HTMLInputElement;
    const maxSize = h("input", { type: "number", min: "1", max: "26214400", value: String(group.maxMessageSize) }) as HTMLInputElement;
    const subscribeStatement = h("textarea", { rows: "6", placeholder: "(no statement — checkbox won't be shown)" }, group.subscribeStatement ?? "") as HTMLTextAreaElement;

    const policy = h("select", null,
      ...policyOptions(group.postingPolicy),
    ) as HTMLSelectElement;
    const replyTo = h("select", null,
      ...replyToOptions(group.replyToPolicy),
    ) as HTMLSelectElement;
    const visibility = h("select", null,
      ...visibilityOptions(group.archiveVisibility),
    ) as HTMLSelectElement;

    const submit = h("button", { class: "btn btn--primary", type: "submit" }, "Save changes") as HTMLButtonElement;

    const form = h("form", {
      class: "panel",
      onsubmit: async (ev) => {
        ev.preventDefault();
        const patch: UpdateGroupInput = {};
        const newDisplay = display.value.trim();
        if (newDisplay && newDisplay !== group.displayName) patch.displayName = newDisplay;
        const newDesc = description.value.trim() || null;
        if (newDesc !== group.description) patch.description = newDesc;
        const newPrefix = subjectPrefix.value.trim() || null;
        if (newPrefix !== group.subjectPrefix) patch.subjectPrefix = newPrefix;
        const newPolicy = policy.value as PostingPolicy;
        if (newPolicy !== group.postingPolicy) patch.postingPolicy = newPolicy;
        const newReplyTo = replyTo.value as ReplyToPolicy;
        if (newReplyTo !== group.replyToPolicy) patch.replyToPolicy = newReplyTo;
        const newVisibility = visibility.value as ArchiveVisibility;
        if (newVisibility !== group.archiveVisibility) {
          if (newVisibility === "public") {
            if (!confirm("Public archives are visible to anyone with the URL — including search engines. Are you sure?")) {
              return;
            }
          }
          patch.archiveVisibility = newVisibility;
        }
        const sizeNum = Number(maxSize.value);
        if (Number.isFinite(sizeNum) && sizeNum > 0 && sizeNum !== group.maxMessageSize) {
          patch.maxMessageSize = Math.floor(sizeNum);
        }
        const newStatement = subscribeStatement.value.trim() || null;
        if (newStatement !== group.subscribeStatement) {
          patch.subscribeStatement = newStatement;
        }

        if (Object.keys(patch).length === 0) {
          banner = { kind: "ok", text: "Nothing to save." };
          draw();
          return;
        }

        submit.disabled = true;
        try {
          await api.updateGroup(group.id, patch);
          Object.assign(group, {
            displayName: patch.displayName ?? group.displayName,
            description: "description" in patch ? patch.description! : group.description,
            subjectPrefix: "subjectPrefix" in patch ? patch.subjectPrefix! : group.subjectPrefix,
            postingPolicy: patch.postingPolicy ?? group.postingPolicy,
            replyToPolicy: patch.replyToPolicy ?? group.replyToPolicy,
            archiveVisibility: patch.archiveVisibility ?? group.archiveVisibility,
            maxMessageSize: patch.maxMessageSize ?? group.maxMessageSize,
            subscribeStatement: "subscribeStatement" in patch ? patch.subscribeStatement! : group.subscribeStatement,
          });
          banner = { kind: "ok", text: "Settings saved." };
          onSaved();
        } catch (err) {
          if (err instanceof HttpError) {
            const p = err.payload as { error?: string; reason?: string } | null;
            banner = { kind: "err", text: `Couldn't save: ${p?.reason ?? p?.error ?? err.message}` };
          } else {
            banner = { kind: "err", text: `Couldn't save: ${(err as Error).message}` };
          }
        } finally {
          submit.disabled = false;
          draw();
        }
      },
    },
      h("h3", null, "Settings"),

      h("div", { class: "field-group" },
        h("label", null, "List name"),
        h("input", { type: "text", value: group.name, disabled: "disabled" }),
        h("p", { class: "hint" }, "Read-only — changing it would break existing replies."),
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
        h("label", null, "Reply-to behavior"),
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
      h("div", { class: "field-group" },
        h("label", null, "Max incoming message size (bytes)"),
        maxSize,
        h("p", { class: "hint" }, "Cloudflare caps inbound at 26214400 / 25 MiB."),
      ),
      h("div", { class: "field-group" },
        h("label", null, "Subscribe-form statement (Markdown-ish)"),
        subscribeStatement,
        h("p", { class: "hint" }, "Shown on the public /join/<group> page. New subscribers must check 'I have read and agree' before submitting. Leave empty to disable the checkbox entirely."),
      ),
      submit,
    );

    const root = h("div", { class: "stack" });
    if (banner) {
      root.appendChild(h("div", { class: `banner ${banner.kind === "ok" ? "banner--ok" : "banner--alert"}` }, banner.text));
    }
    root.appendChild(form);
    root.appendChild(renderDangerZone(group, draw, () => { banner = null; }));
    mount(host, root);
  };

  draw();
}

/**
 * Rename + delete controls. Both actions are gated server-side on
 * `activeMemberCount + messageCount === 0`. We use the cached group's
 * activeMemberCount + lastMessageAt to surface a disabled state up
 * front, but the server is the authority — a 409 surfaces the actual
 * member/message counts so the UI can explain the gate.
 */
function renderDangerZone(
  group: GroupSummary,
  redraw: () => void,
  clearBanner: () => void,
): HTMLElement {
  const hasTraffic = group.activeMemberCount > 0 || group.lastMessageAt !== null;

  if (hasTraffic) {
    return h("section", { class: "panel panel--danger" },
      h("h3", null, "Danger zone"),
      h("p", { class: "hint" },
        `This list has ${group.activeMemberCount} active member${group.activeMemberCount === 1 ? "" : "s"}${
          group.lastMessageAt !== null ? " and has received messages" : ""
        }. Rename and delete are disabled while the list has traffic — both actions would break threading on existing replies and orphan subscribers. A migrate-or-archive flow for populated lists isn't built yet.`,
      ),
    );
  }

  // Rename
  const renameInput = h("input", { type: "text", value: group.name }) as HTMLInputElement;
  const renameBtn = h("button", { class: "btn", type: "submit" }, "Rename list") as HTMLButtonElement;
  const renameForm = h("form", {
    onsubmit: async (ev: Event) => {
      ev.preventDefault();
      const newName = renameInput.value.trim().toLowerCase();
      if (newName === group.name) return;
      if (!confirm(`Rename '${group.name}' to '${newName}'? This changes the list's email address.`)) return;
      renameBtn.disabled = true;
      try {
        await api.updateGroup(group.id, { name: newName });
        group.name = newName;
        clearBanner();
        redraw();
      } catch (err) {
        const msg = err instanceof HttpError
          ? (() => {
              const p = err.payload as { error?: string; members?: number; messages?: number } | null;
              if (p?.error === "name_taken") return "That name is already used by another list.";
              if (p?.error === "invalid_name") return "Invalid list name. Use lowercase letters, numbers, and dashes.";
              if (p?.error === "group_has_traffic") {
                return `Can't rename — list has ${p.members ?? 0} member(s) and ${p.messages ?? 0} message(s).`;
              }
              return p?.error ?? err.message;
            })()
          : (err as Error).message;
        alert(`Couldn't rename: ${msg}`);
      } finally {
        renameBtn.disabled = false;
      }
    },
  },
    h("h4", null, "Rename"),
    h("p", { class: "hint" }, "Changes the email local-part. Only available while the list is empty."),
    h("div", { class: "field-group" },
      h("label", null, "New list name"),
      renameInput,
    ),
    renameBtn,
  );

  // Delete with type-to-confirm
  const confirmInput = h("input", {
    type: "text",
    placeholder: `Type "${group.name}" to confirm`,
    autocomplete: "off",
  }) as HTMLInputElement;
  const deleteBtn = h("button", {
    class: "btn btn--alert",
    type: "submit",
    disabled: "disabled",
  }, "Delete this list") as HTMLButtonElement;
  confirmInput.addEventListener("input", () => {
    deleteBtn.disabled = confirmInput.value.trim() !== group.name;
  });
  const deleteForm = h("form", {
    onsubmit: async (ev: Event) => {
      ev.preventDefault();
      if (confirmInput.value.trim() !== group.name) return;
      deleteBtn.disabled = true;
      try {
        await api.deleteGroup(group.id);
        // Send the user back to the home page — the group they were on
        // no longer exists.
        location.hash = "#/";
      } catch (err) {
        const msg = err instanceof HttpError
          ? (() => {
              const p = err.payload as { error?: string; members?: number; messages?: number } | null;
              if (p?.error === "group_has_traffic") {
                return `Can't delete — list has ${p.members ?? 0} member(s) and ${p.messages ?? 0} message(s). The page is showing stale activity counts; refresh and try again, or migrate subscribers first.`;
              }
              return p?.error ?? err.message;
            })()
          : (err as Error).message;
        alert(`Couldn't delete: ${msg}`);
        deleteBtn.disabled = false;
      }
    },
  },
    h("h4", null, "Delete"),
    h("p", { class: "hint" }, "Permanently removes the list and any pending subscription requests. Cannot be undone."),
    h("div", { class: "field-group" },
      h("label", null, `Type the list name (${group.name}) to confirm`),
      confirmInput,
    ),
    deleteBtn,
  );

  return h("section", { class: "panel panel--danger" },
    h("h3", null, "Danger zone"),
    renameForm,
    h("hr"),
    deleteForm,
  );
}

function policyOptions(current: PostingPolicy) {
  const opts: Array<[PostingPolicy, string]> = [
    ["members", "Members can post"],
    ["open", "Open (anyone can post)"],
    ["moderated", "Moderated (admin approves each post)"],
    ["announce_only", "Announce only (moderators/sender-only roles)"],
  ];
  return opts.map(([v, label]) =>
    h("option", { value: v, ...(v === current ? { selected: "selected" } : {}) }, label),
  );
}

function replyToOptions(current: ReplyToPolicy) {
  const opts: Array<[ReplyToPolicy, string]> = [
    ["list", "List (replies go back to everyone)"],
    ["sender", "Sender (replies go privately to the author)"],
  ];
  return opts.map(([v, label]) =>
    h("option", { value: v, ...(v === current ? { selected: "selected" } : {}) }, label),
  );
}

function visibilityOptions(current: ArchiveVisibility) {
  const opts: Array<[ArchiveVisibility, string]> = [
    ["members", "Members-only"],
    ["none", "No archive"],
    ["public", "Public (anyone with the URL)"],
  ];
  return opts.map(([v, label]) =>
    h("option", { value: v, ...(v === current ? { selected: "selected" } : {}) }, label),
  );
}
