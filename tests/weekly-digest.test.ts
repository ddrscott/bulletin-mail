/**
 * Weekly member digest unit tests — the pure parts:
 *   - per-recipient thread filtering (archive_visibility matrix)
 *   - wiki activity summarization (window, private pages, dedupe, new-vs-edit)
 *   - email rendering (sections, permalinks, opt-out link, counts)
 */

import { describe, expect, it } from "vitest";
import type { InstanceConfig } from "@bulletinmail/shared";
import type { Tenant, WeeklyThreadActivityRow } from "@bulletinmail/db";
import {
  filterThreadsForRecipient,
  renderWeeklyDigestEmail,
  summarizeWikiActivity,
  WEEKLY_DIGEST_CRON,
} from "../workers/sender/src/weekly-digest.js";

const thread = (overrides: Partial<WeeklyThreadActivityRow>): WeeklyThreadActivityRow => ({
  thread_id: "th_1",
  group_id: "g_1",
  group_name: "announcements",
  group_display_name: "Announcements",
  archive_visibility: "members",
  subject: "Bake sale",
  new_messages: 3,
  participant_count: 2,
  last_activity_at: 1000,
  started_in_window: 1,
  ...overrides,
});

const tenant = { id: "t_1", slug: "firstpresby", display_name: "First Presby" } as Tenant;
const config = { productName: "Example Lists" } as InstanceConfig;

describe("filterThreadsForRecipient", () => {
  it("hides visibility='none' groups from everyone", () => {
    const rows = [thread({ archive_visibility: "none" })];
    expect(filterThreadsForRecipient(rows, new Set(["g_1"]))).toHaveLength(0);
  });

  it("shows tenant-public groups to non-members", () => {
    const rows = [thread({ archive_visibility: "public" })];
    expect(filterThreadsForRecipient(rows, new Set())).toHaveLength(1);
  });

  it("shows members-only groups to members of that group only", () => {
    const rows = [thread({ archive_visibility: "members", group_id: "g_1" })];
    expect(filterThreadsForRecipient(rows, new Set(["g_1"]))).toHaveLength(1);
    expect(filterThreadsForRecipient(rows, new Set(["g_other"]))).toHaveLength(0);
  });
});

describe("summarizeWikiActivity", () => {
  const row = (overrides: Partial<Parameters<typeof summarizeWikiActivity>[0][number]>) => ({
    page_id: "p1",
    page_slug: "index",
    page_title: "Home",
    page_created_at: 0,
    page_visibility: "public" as const,
    created_at: 100,
    ...overrides,
  });

  it("drops edits outside the window", () => {
    expect(summarizeWikiActivity([row({ created_at: 10 })], 50)).toHaveLength(0);
  });

  it("skips private pages", () => {
    expect(summarizeWikiActivity([row({ page_visibility: "private" })], 50)).toHaveLength(0);
  });

  it("folds multiple edits of one page into an edit count", () => {
    const items = summarizeWikiActivity(
      [row({ created_at: 100 }), row({ created_at: 110 }), row({ created_at: 120 })],
      50,
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.edits).toBe(3);
  });

  it("classifies pages created inside the window as new", () => {
    const items = summarizeWikiActivity([row({ page_created_at: 60 })], 50);
    expect(items[0]!.is_new).toBe(true);
    const older = summarizeWikiActivity([row({ page_created_at: 10 })], 50);
    expect(older[0]!.is_new).toBe(false);
  });
});

describe("renderWeeklyDigestEmail", () => {
  const base = "https://firstpresby.example.org";
  const optOutUrl = `${base}/digest/unsub/tok123`;

  it("splits new vs active threads and links permalinks", () => {
    const mail = renderWeeklyDigestEmail({
      config, tenant, base, optOutUrl,
      threads: [
        thread({ thread_id: "th_new", subject: "Fresh topic", started_in_window: 1 }),
        thread({ thread_id: "th_old", subject: "Old topic", started_in_window: 0 }),
      ],
      wikiItems: [],
    });
    expect(mail.subject).toBe("This week on First Presby");
    expect(mail.html).toContain("New threads");
    expect(mail.html).toContain("Active threads");
    expect(mail.html).toContain(`${base}/t/th_new`);
    expect(mail.text).toContain(`${base}/t/th_old`);
    // no wiki section when there is no wiki activity
    expect(mail.html).not.toContain("Wiki");
  });

  it("renders the wiki section with new-page vs edit labels", () => {
    const mail = renderWeeklyDigestEmail({
      config, tenant, base, optOutUrl,
      threads: [],
      wikiItems: [
        { page_slug: "history", page_title: "Our History", edits: 1, is_new: true },
        { page_slug: "faq", page_title: "FAQ", edits: 4, is_new: false },
      ],
    });
    expect(mail.html).toContain("new page");
    expect(mail.html).toContain("4 edits");
    expect(mail.html).toContain(`${base}/wiki/history`);
    expect(mail.text).toContain(`${base}/wiki/faq`);
  });

  it("always carries the digest opt-out link in text and html", () => {
    const mail = renderWeeklyDigestEmail({
      config, tenant, base, optOutUrl,
      threads: [thread({})],
      wikiItems: [],
    });
    expect(mail.text).toContain(optOutUrl);
    expect(mail.html).toContain(optOutUrl);
  });

  it("escapes HTML in subjects and titles", () => {
    const mail = renderWeeklyDigestEmail({
      config, tenant, base, optOutUrl,
      threads: [thread({ subject: `<img src=x onerror=alert(1)>` })],
      wikiItems: [],
    });
    expect(mail.html).not.toContain("<img src=x");
  });
});

describe("cron constant", () => {
  it("is a Sunday-only weekly expression", () => {
    expect(WEEKLY_DIGEST_CRON.trim().split(/\s+/)).toHaveLength(5);
    // Cloudflare's cron parser rejects numeric 0 as day-of-week (its range is
    // 1-7 / SUN-SAT) — the schedule upload fails with "invalid cron string"
    // (code 10100). Pin the name form so a well-meaning revert to `* * 0`
    // can't break the deploy again.
    expect(WEEKLY_DIGEST_CRON.endsWith("SUN")).toBe(true);
  });
});
