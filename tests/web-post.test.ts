/**
 * Web posting unit tests — the pure parts of server/archive/post.ts:
 *   - posting-policy permission matrix (mirror of workers/inbound
 *     validateSender, including identical reason strings)
 *   - reply-subject construction (never "Re: Re:")
 *   - body normalization + input validation limits
 *
 * The fan-out itself (D1 + EMAIL binding) is exercised via `wrangler dev`,
 * same as the sender Worker — not here.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_BODY_CHARS,
  MAX_SUBJECT_CHARS,
  normalizeBody,
  POST_RATE_LIMIT,
  postPermissionFor,
  replySubjectFor,
  validateNewThreadInput,
  validateReplyInput,
} from "../server/archive/post.js";
import type { Group, Member } from "@bulletinmail/db";

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

function member(overrides: Partial<Member>): Member {
  return {
    id: "m_1",
    group_id: "g_1",
    email: "m@x.co",
    display_name: null,
    role: "member",
    delivery_mode: "each",
    status: "active",
    bounce_count: 0,
    last_bounce_at: null,
    joined_at: 0,
    ...overrides,
  } as Member;
}

describe("postPermissionFor", () => {
  it("open lists accept any signed-in viewer, member or not", () => {
    expect(postPermissionFor(group({ posting_policy: "open" }), null).ok).toBe(true);
    expect(postPermissionFor(group({ posting_policy: "open" }), member({})).ok).toBe(true);
  });

  it("members lists require an ACTIVE membership", () => {
    expect(postPermissionFor(group({}), member({})).ok).toBe(true);
    const noMember = postPermissionFor(group({}), null);
    expect(noMember).toEqual({ ok: false, reason: "Only active members may post to this list" });
    // Same rejection for unsubscribed / bouncing / pending rows.
    for (const status of ["unsubscribed", "bouncing", "pending_confirmation"] as const) {
      expect(postPermissionFor(group({}), member({ status })).ok).toBe(false);
    }
  });

  it("announce_only requires moderator or sender_only role", () => {
    const g = group({ posting_policy: "announce_only" });
    expect(postPermissionFor(g, member({ role: "moderator" })).ok).toBe(true);
    expect(postPermissionFor(g, member({ role: "sender_only" })).ok).toBe(true);
    expect(postPermissionFor(g, member({ role: "member" }))).toEqual({
      ok: false,
      reason: "Only authorized senders may post to this announce-only list",
    });
    expect(postPermissionFor(g, null)).toEqual({
      ok: false,
      reason: "This list does not accept posts from this address",
    });
  });

  it("moderated lists refuse with the SAME reason the email path bounces with", () => {
    // Parity invariant: workers/inbound validateSender emits this exact
    // string for posting_policy='moderated'. If the moderation queue ships
    // and inbound changes, this must change with it.
    expect(postPermissionFor(group({ posting_policy: "moderated" }), member({}))).toEqual({
      ok: false,
      reason: "Moderation queue not yet implemented (V2)",
    });
  });

  it("returns the active membership row so the caller can use its display name", () => {
    const m = member({ display_name: "Scott P" });
    const perm = postPermissionFor(group({}), m);
    expect(perm.ok && perm.member?.display_name).toBe("Scott P");
  });
});

describe("replySubjectFor", () => {
  it("prepends Re: to a plain subject", () => {
    expect(replySubjectFor("Fall festival")).toBe("Re: Fall festival");
  });
  it("does not stack Re: on an existing reply subject", () => {
    expect(replySubjectFor("Re: Fall festival")).toBe("Re: Fall festival");
    expect(replySubjectFor("RE: Fall festival")).toBe("RE: Fall festival");
    expect(replySubjectFor("Re[2]: Fall festival")).toBe("Re[2]: Fall festival");
  });
  it("trims surrounding whitespace before deciding", () => {
    expect(replySubjectFor("  Re: x  ")).toBe("Re: x");
    expect(replySubjectFor("  x  ")).toBe("Re: x");
  });
});

describe("normalizeBody", () => {
  it("converts CRLF and lone CR to LF", () => {
    expect(normalizeBody("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });
  it("strips trailing whitespace", () => {
    expect(normalizeBody("hello\n\n  \n")).toBe("hello");
  });
});

describe("input validation", () => {
  it("rejects empty bodies", () => {
    expect(validateReplyInput("")).toHaveLength(1);
    expect(validateReplyInput("   \n ")).toHaveLength(1);
    expect(validateReplyInput("hi")).toHaveLength(0);
  });
  it("rejects oversized bodies", () => {
    expect(validateReplyInput("x".repeat(MAX_BODY_CHARS))).toHaveLength(0);
    expect(validateReplyInput("x".repeat(MAX_BODY_CHARS + 1))).toHaveLength(1);
  });
  it("new threads need a subject within limits", () => {
    expect(validateNewThreadInput("", "body")).toHaveLength(1);
    expect(validateNewThreadInput("x".repeat(MAX_SUBJECT_CHARS + 1), "body")).toHaveLength(1);
    expect(validateNewThreadInput("Subject", "body")).toHaveLength(0);
    // Errors compose: blank subject AND blank body → two errors.
    expect(validateNewThreadInput("", "")).toHaveLength(2);
  });
});

describe("rate limit constants", () => {
  it("stays sane for small-org scale", () => {
    expect(POST_RATE_LIMIT.max).toBeGreaterThan(0);
    expect(POST_RATE_LIMIT.windowMs).toBeGreaterThan(0);
  });
});
