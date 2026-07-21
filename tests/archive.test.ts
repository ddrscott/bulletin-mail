/**
 * Archive browser unit tests — the pure parts:
 *   - member session cookie (issue/verify/tamper/tenant-scope)
 *   - group visibility rules (canViewGroup)
 *   - open-redirect guard (safeReturnTo)
 *   - sanitizer policy fns (URL scheme filter, event-handler attrs, cid
 *     rewriting) — sanitizeEmailHtml itself needs HTMLRewriter (Workers
 *     runtime) so it is exercised via `wrangler dev`, not here.
 *   - plain-text body rendering + display helpers
 */

import { describe, expect, it } from "vitest";
import {
  buildMemberSetCookie,
  issueMemberSessionCookie,
  readMemberCookieFromHeader,
  verifyMemberSessionCookie,
  MEMBER_COOKIE_NAME,
} from "../server/archive/member-auth.js";
import { canViewGroup, safeReturnTo, type ArchiveViewer } from "../server/archive/routes.js";
import {
  isEventHandlerAttr,
  isSafeUrl,
  normalizeContentId,
  renderPlainTextBody,
  resolveImgSrc,
} from "../server/archive/sanitize.js";
import { formatBytes, obfuscateEmail, senderLabel } from "../server/archive/render.js";
import type { Group, Admin } from "@bulletinmail/db";

const SECRET = "test-secret-1234567890abcdef";

describe("member session cookie", () => {
  it("round-trips email + tenantId", async () => {
    const value = await issueMemberSessionCookie("Person@Example.COM", "t_1", SECRET);
    const payload = await verifyMemberSessionCookie(value, SECRET);
    expect(payload?.email).toBe("person@example.com");
    expect(payload?.tenantId).toBe("t_1");
    expect(payload?.exp).toBeGreaterThan(Date.now());
  });

  it("rejects a tampered payload", async () => {
    const value = await issueMemberSessionCookie("a@b.co", "t_1", SECRET);
    const [payload, sig] = value.split(".") as [string, string];
    const tampered = `${payload}x.${sig}`;
    expect(await verifyMemberSessionCookie(tampered, SECRET)).toBeNull();
  });

  it("rejects the wrong secret", async () => {
    const value = await issueMemberSessionCookie("a@b.co", "t_1", SECRET);
    expect(await verifyMemberSessionCookie(value, "other-secret")).toBeNull();
  });

  it("rejects an expired session", async () => {
    const past = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const value = await issueMemberSessionCookie("a@b.co", "t_1", SECRET, past);
    expect(await verifyMemberSessionCookie(value, SECRET)).toBeNull();
  });

  it("reads its own cookie out of a header with other cookies present", async () => {
    const value = await issueMemberSessionCookie("a@b.co", "t_1", SECRET);
    const header = `foo=bar; ${MEMBER_COOKIE_NAME}=${value}; baz=qux`;
    expect(readMemberCookieFromHeader(header)).toBe(value);
    expect(buildMemberSetCookie(value)).toContain("HttpOnly");
    expect(buildMemberSetCookie(value)).toContain("SameSite=Lax");
  });
});

function group(overrides: Partial<Group>): Group {
  return {
    id: "g_1",
    tenant_id: "t_1",
    name: "announcements",
    display_name: "Announcements",
    description: null,
    posting_policy: "members",
    reply_to_policy: "list",
    subject_prefix: null,
    archive_visibility: "members",
    max_message_size: 10485760,
    subscribe_statement: null,
    created_at: 0,
    ...overrides,
  } as Group;
}

const adminViewer: ArchiveViewer = {
  kind: "admin",
  admin: { id: "a_1", tenant_id: "t_1" } as Admin,
  label: "Admin",
};
const memberViewer: ArchiveViewer = {
  kind: "member",
  email: "m@x.co",
  groupIds: new Set(["g_1"]),
  label: "m@x.co",
};

describe("canViewGroup", () => {
  it("admin sees members-visibility groups", () => {
    expect(canViewGroup(adminViewer, group({}))).toBe(true);
  });
  it("nobody sees archive_visibility=none — not even admins", () => {
    expect(canViewGroup(adminViewer, group({ archive_visibility: "none" }))).toBe(false);
    expect(canViewGroup(memberViewer, group({ archive_visibility: "none" }))).toBe(false);
  });
  it("member sees groups they belong to", () => {
    expect(canViewGroup(memberViewer, group({ id: "g_1" }))).toBe(true);
    expect(canViewGroup(memberViewer, group({ id: "g_other" }))).toBe(false);
  });
  it("member sees tenant-public groups they do not belong to", () => {
    expect(
      canViewGroup(memberViewer, group({ id: "g_other", archive_visibility: "public" })),
    ).toBe(true);
  });
});

describe("safeReturnTo", () => {
  it("accepts same-site paths", () => {
    expect(safeReturnTo("/t/abc123")).toBe("/t/abc123");
    expect(safeReturnTo("/archive/announcements?page=2")).toBe("/archive/announcements?page=2");
  });
  it("rejects absolute URLs, protocol-relative, backslashes, and junk", () => {
    expect(safeReturnTo("https://evil.com/")).toBeNull();
    expect(safeReturnTo("//evil.com")).toBeNull();
    expect(safeReturnTo("/\\evil.com")).toBeNull();
    expect(safeReturnTo("/a\r\nSet-Cookie: x=y")).toBeNull();
    expect(safeReturnTo("")).toBeNull();
  });
});

describe("sanitizer policy", () => {
  it("flags event-handler attributes", () => {
    expect(isEventHandlerAttr("onclick")).toBe(true);
    expect(isEventHandlerAttr("ONError")).toBe(true);
    expect(isEventHandlerAttr("class")).toBe(false);
  });

  it("allows http(s), mailto, relative; rejects javascript:/data:/vbscript:", () => {
    expect(isSafeUrl("https://example.com/a")).toBe(true);
    expect(isSafeUrl("http://example.com")).toBe(true);
    expect(isSafeUrl("mailto:a@b.co")).toBe(true);
    expect(isSafeUrl("/relative/path")).toBe(true);
    expect(isSafeUrl("#fragment")).toBe(true);
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("JaVaScRiPt:alert(1)")).toBe(false);
    expect(isSafeUrl("jav\tascript:alert(1)")).toBe(false);
    expect(isSafeUrl(" \n javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("data:text/html,<script>1</script>")).toBe(false);
    expect(isSafeUrl("vbscript:msgbox(1)")).toBe(false);
  });

  it("treats a colon after /, # or ? as not-a-scheme", () => {
    expect(isSafeUrl("./a:b")).toBe(true);
    expect(isSafeUrl("/path/a:b")).toBe(true);
    expect(isSafeUrl("#a:b")).toBe(true);
  });

  it("rewrites known cid: images and blocks everything else", () => {
    const cidMap = new Map([["img001@mailer", "/archive/att/att_1"]]);
    expect(resolveImgSrc("cid:img001@mailer", cidMap)).toEqual({
      kind: "rewrite",
      url: "/archive/att/att_1",
    });
    expect(resolveImgSrc("CID:<img001@mailer>", cidMap)).toEqual({
      kind: "rewrite",
      url: "/archive/att/att_1",
    });
    expect(resolveImgSrc("cid:unknown@x", cidMap)).toEqual({ kind: "blocked" });
    expect(resolveImgSrc("https://tracker.example/pixel.gif", cidMap)).toEqual({ kind: "blocked" });
    expect(resolveImgSrc("data:image/png;base64,AAAA", cidMap)).toEqual({ kind: "blocked" });
  });

  it("normalizes Content-ID header values", () => {
    expect(normalizeContentId("<Img001@Mailer>")).toBe("img001@mailer");
    expect(normalizeContentId("plain-id")).toBe("plain-id");
  });
});

describe("renderPlainTextBody", () => {
  it("escapes HTML", () => {
    const out = renderPlainTextBody("<script>alert(1)</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&#60;script&#62;");
  });
  it("autolinks http(s) URLs", () => {
    const out = renderPlainTextBody("see https://example.com/x for details");
    expect(out).toContain('<a href="https://example.com/x"');
    expect(out).toContain('rel="noopener noreferrer"');
  });
  it("marks quoted lines", () => {
    const out = renderPlainTextBody("reply\n> original text");
    expect(out).toContain('<span class="quote">');
  });
});

describe("display helpers", () => {
  it("obfuscates email domains", () => {
    expect(obfuscateEmail("scott@example.com")).toBe("scott@e…");
  });
  it("prefers the sender name, falls back to obfuscated email", () => {
    expect(senderLabel("Scott P", "scott@example.com")).toBe("Scott P");
    expect(senderLabel("  ", "scott@example.com")).toBe("scott@e…");
    expect(senderLabel(null, "scott@example.com")).toBe("scott@e…");
  });
  it("formats byte sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3.4 * 1024 * 1024)).toBe("3.4 MB");
  });
});
