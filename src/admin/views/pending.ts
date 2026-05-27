import { h, mount, fmtDate } from "../dom.js";
import { api, HttpError } from "../api.js";
import type { GroupSummary, PendingRequest } from "../api.js";

export function renderPendingTab(host: HTMLElement, group: GroupSummary, onApproved: () => void): void {
  let requests: PendingRequest[] = [];
  let banner: { kind: "ok" | "err"; text: string } | null = null;

  const reload = async () => {
    try {
      requests = (await api.listPending(group.id)).requests;
    } catch (err) {
      banner = { kind: "err", text: `Failed to load: ${(err as Error).message}` };
    }
    draw();
  };

  const approve = async (r: PendingRequest) => {
    if (!confirm(`Approve ${r.email}? They will be added to ${group.displayName} immediately.`)) return;
    try {
      const result = await api.approvePending(group.id, r.id);
      banner = {
        kind: "ok",
        text: result.existed
          ? `${r.email} was already a member; request marked approved.`
          : `${r.email} approved and added to ${group.displayName}.`,
      };
      await reload();
      onApproved();
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        banner = { kind: "err", text: "Request was already decided by another moderator." };
      } else {
        banner = { kind: "err", text: `Approval failed: ${(err as Error).message}` };
      }
      draw();
    }
  };

  const reject = async (r: PendingRequest) => {
    const note = prompt(`Reject ${r.email}? (Optional moderator note — not sent to the requester.)`, "");
    if (note === null) return; // cancelled
    try {
      await api.rejectPending(group.id, r.id, note || undefined);
      banner = { kind: "ok", text: `Rejected ${r.email}.` };
      await reload();
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        banner = { kind: "err", text: "Request was already decided by another moderator." };
      } else {
        banner = { kind: "err", text: `Rejection failed: ${(err as Error).message}` };
      }
      draw();
    }
  };

  const draw = () => {
    const root = h("div", { class: "stack" });
    // The SPA is served at <tenant>.<apex>/admin/ so location.host already is
    // the correct host for the public subscribe URL.
    const shareUrl = `https://${location.host}/join/${group.name}`;
    root.appendChild(h("div", { class: "panel" },
      h("h3", null, "Public subscribe link"),
      h("p", { class: "small" }, "Share this URL anywhere people can sign up:"),
      h("p", null, h("code", null, shareUrl)),
      h("p", { class: "small muted" }, "Submissions land here for moderator review."),
    ));

    if (banner) root.appendChild(h("div", { class: `banner ${banner.kind === "ok" ? "banner--ok" : "banner--alert"}` }, banner.text));

    if (requests.length === 0) {
      root.appendChild(h("div", { class: "empty" }, "No pending requests."));
    } else {
      root.appendChild(renderTable(requests, approve, reject));
    }
    mount(host, root);
  };

  draw();
  void reload();
}

function renderTable(
  requests: PendingRequest[],
  approve: (r: PendingRequest) => void,
  reject: (r: PendingRequest) => void,
): HTMLElement {
  return h("div", { class: "panel" }, h("div", { class: "table-wrap" }, h("table", null,
    h("thead", null, h("tr", null,
      h("th", null, "Name"),
      h("th", null, "Email"),
      h("th", null, "About"),
      h("th", null, "Submitted"),
      h("th", null, ""),
    )),
    h("tbody", null, ...requests.map((r) => h("tr", null,
      h("td", null, r.displayName),
      h("td", { class: "small" }, r.email),
      h("td", { class: "small muted", style: { maxWidth: "20rem" } }, r.about ?? ""),
      h("td", { class: "small muted" }, fmtDate(r.createdAt)),
      h("td", null, h("div", { class: "row" },
        h("button", { class: "btn btn--primary", onclick: () => approve(r) }, "Approve"),
        h("button", { class: "btn", onclick: () => reject(r) }, "Reject"),
      )),
    ))),
  )));
}
