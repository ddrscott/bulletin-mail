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
    mount(host, root);
  };

  draw();
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
