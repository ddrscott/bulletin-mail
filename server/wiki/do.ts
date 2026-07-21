/**
 * TenantWikiDO — one Durable Object instance per tenant, sharded by tenant
 * slug (`env.WIKI.idFromName(tenant.slug)`).
 *
 * Schema (SQLite, lives inside the DO):
 *
 *   pages
 *     id                TEXT PK
 *     slug              TEXT UNIQUE NOT NULL    -- url slug, e.g. "index", "history"
 *     title             TEXT NOT NULL
 *     parent_id         TEXT NULL              -- breadcrumb / tree (FK to pages.id)
 *     current_version_id TEXT NOT NULL          -- FK to versions.id
 *     updated_at        INTEGER NOT NULL
 *     created_at        INTEGER NOT NULL
 *
 *   versions
 *     id                TEXT PK
 *     page_id           TEXT NOT NULL          -- FK pages.id (no cascade — keep history)
 *     md_source         TEXT NOT NULL          -- raw markdown
 *     html_compiled     TEXT NOT NULL          -- server-compiled HTML cache
 *     author_admin_id   TEXT NOT NULL
 *     note              TEXT NULL              -- optional revision note
 *     summary           TEXT NULL              -- AI-generated change summary
 *     added_lines       INTEGER NULL           -- deterministic line delta vs prev
 *     removed_lines     INTEGER NULL
 *     created_at        INTEGER NOT NULL
 *
 * Writes go through RPC methods invoked from the Worker. Each save creates a
 * fresh version row (append-only) AND updates pages.current_version_id +
 * updated_at. Reverts insert a NEW version row referencing the older content
 * — we never mutate or delete old versions.
 *
 * The activity feed (cross-page, newest-first list of recent edits) reads
 * versions + pages via listRecentActivity; per-row deltas come from the
 * added_lines/removed_lines columns, summaries from the summary column.
 */

import { DurableObject } from "cloudflare:workers";
import { computeLineDelta, computeUnifiedDiff } from "./summary.js";

export type PageVisibility = "public" | "private";

export type PageRow = {
  id: string;
  slug: string;
  title: string;
  parent_id: string | null;
  current_version_id: string;
  visibility: PageVisibility;
  updated_at: number;
  created_at: number;
};

export type VersionRow = {
  id: string;
  page_id: string;
  md_source: string;
  html_compiled: string;
  author_admin_id: string;
  note: string | null;
  created_at: number;
  /**
   * AI-generated 1–2 sentence summary of the change. NULL for older rows
   * (no backfill) and for rows whose summary call hasn't completed (or
   * failed). The activity feed shows "Minor changes." when null.
   */
  summary: string | null;
  /**
   * Deterministic line-count delta vs. the previous version, written at
   * save time. NULL on the first save and for rows older than this feature.
   * The activity feed uses these as the ground-truth change signal — the
   * AI summary is a convenience layer on top.
   */
  added_lines: number | null;
  removed_lines: number | null;
  /**
   * Unified diff (3 lines context) between this version's md_source and
   * the previous version's. Same string that's sent to the AI summarizer.
   * NULL for the first version on a page (there's nothing to diff against)
   * and for rows older than this feature. Rendered in the activity feed
   * inside a <details> expander so reviewers can see the actual change.
   */
  diff_unified: string | null;
};

/**
 * Row shape for the cross-page activity feed. JOIN of versions + pages so
 * the feed never round-trips the DO per row.
 */
export type ActivityRow = {
  version_id: string;
  page_id: string;
  page_slug: string;
  page_title: string;
  /** When the PAGE was created — lets consumers (weekly digest) classify a
   *  version as "new page" vs "update" without a second round-trip. */
  page_created_at: number;
  /** Current page visibility — digest consumers must skip private pages. */
  page_visibility: PageVisibility;
  author_admin_id: string;
  note: string | null;
  summary: string | null;
  added_lines: number | null;
  removed_lines: number | null;
  diff_unified: string | null;
  created_at: number;
};

export type PageWithCurrentVersion = PageRow & {
  md_source: string;
  html_compiled: string;
  author_admin_id: string;
};

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS pages (
     id                  TEXT PRIMARY KEY,
     slug                TEXT NOT NULL UNIQUE,
     title               TEXT NOT NULL,
     parent_id           TEXT,
     current_version_id  TEXT NOT NULL,
     visibility          TEXT NOT NULL DEFAULT 'public',
     updated_at          INTEGER NOT NULL,
     created_at          INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS versions (
     id                  TEXT PRIMARY KEY,
     page_id             TEXT NOT NULL,
     md_source           TEXT NOT NULL,
     html_compiled       TEXT NOT NULL,
     author_admin_id     TEXT NOT NULL,
     note                TEXT,
     summary             TEXT,
     added_lines         INTEGER,
     removed_lines       INTEGER,
     diff_unified        TEXT,
     created_at          INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_versions_page_created
     ON versions(page_id, created_at DESC)`,
  // Cross-page activity feed sorts every version by created_at DESC.
  `CREATE INDEX IF NOT EXISTS idx_versions_created
     ON versions(created_at DESC)`,
];

// In-place migrations for DO instances that were created before each column.
// Each runs once per DO startup; SQLite throws "duplicate column" the second
// time, which we catch and ignore so the migration is idempotent.
const COLUMN_MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  {
    table: "pages",
    column: "visibility",
    ddl: "ALTER TABLE pages ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'",
  },
  {
    table: "versions",
    column: "summary",
    ddl: "ALTER TABLE versions ADD COLUMN summary TEXT",
  },
  {
    table: "versions",
    column: "added_lines",
    ddl: "ALTER TABLE versions ADD COLUMN added_lines INTEGER",
  },
  {
    table: "versions",
    column: "removed_lines",
    ddl: "ALTER TABLE versions ADD COLUMN removed_lines INTEGER",
  },
  {
    table: "versions",
    column: "diff_unified",
    ddl: "ALTER TABLE versions ADD COLUMN diff_unified TEXT",
  },
];

const ulid = (): string => {
  // 26-char ulid using the existing shared helper would require a workspace
  // import in DO context; the DO is co-located with the Worker so we just
  // generate hex ids of similar uniqueness here. Length kept similar to ulid
  // (16 random bytes hex = 32 chars).
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < buf.length; i++) s += buf[i]!.toString(16).padStart(2, "0");
  return s;
};

export class TenantWikiDO extends DurableObject {
  private initialized = false;

  override async fetch(request: Request): Promise<Response> {
    // The DO is invoked via stub.fetch() in the Worker. We use a tiny
    // path-based router as a JSON-RPC surface; everything is POST + JSON.
    this.ensureSchema();
    const url = new URL(request.url);

    try {
      switch (`${request.method} ${url.pathname}`) {
        case "POST /rpc/getPage": {
          const { slug } = await request.json<{ slug: string }>();
          return Response.json(this.getPage(slug));
        }
        case "POST /rpc/listPages":
          return Response.json(this.listPages());
        case "POST /rpc/savePage": {
          const body = await request.json<SavePageInput>();
          return Response.json(this.savePage(body));
        }
        case "POST /rpc/listVersions": {
          const { pageId } = await request.json<{ pageId: string }>();
          return Response.json(this.listVersions(pageId));
        }
        case "POST /rpc/getVersion": {
          const { versionId } = await request.json<{ versionId: string }>();
          return Response.json(this.getVersion(versionId));
        }
        case "POST /rpc/revertToVersion": {
          const body = await request.json<RevertInput>();
          return Response.json(this.revertToVersion(body));
        }
        case "POST /rpc/updateVersionSummary": {
          const body = await request.json<UpdateVersionSummaryInput>();
          return Response.json(this.updateVersionSummary(body));
        }
        case "POST /rpc/listRecentActivity": {
          const body = await request.json<{ limit?: number }>();
          return Response.json(this.listRecentActivity(body.limit ?? 50));
        }
        default:
          return new Response("not found", { status: 404 });
      }
    } catch (err) {
      console.error("WIKI DO error", err);
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  }

  private ensureSchema(): void {
    if (this.initialized) return;
    const db = this.ctx.storage.sql;
    for (const stmt of SCHEMA_SQL) db.exec(stmt);
    for (const { ddl } of COLUMN_MIGRATIONS) {
      try { db.exec(ddl); } catch { /* column already exists */ }
    }
    this.initialized = true;
  }

  // ---- read --------------------------------------------------------------

  getPage(slug: string): PageWithCurrentVersion | null {
    const db = this.ctx.storage.sql;
    const page = db
      .exec<PageRow>(
        "SELECT id, slug, title, parent_id, current_version_id, visibility, updated_at, created_at FROM pages WHERE slug = ?",
        slug,
      )
      .toArray()[0];
    if (!page) return null;
    const ver = db
      .exec<VersionRow>(
        "SELECT id, page_id, md_source, html_compiled, author_admin_id, note, summary, added_lines, removed_lines, created_at FROM versions WHERE id = ?",
        page.current_version_id,
      )
      .toArray()[0];
    if (!ver) return null;
    return {
      ...page,
      md_source: ver.md_source,
      html_compiled: ver.html_compiled,
      author_admin_id: ver.author_admin_id,
    };
  }

  listPages(): PageRow[] {
    return this.ctx.storage.sql
      .exec<PageRow>(
        "SELECT id, slug, title, parent_id, current_version_id, visibility, updated_at, created_at FROM pages ORDER BY slug",
      )
      .toArray();
  }

  listVersions(pageId: string): VersionRow[] {
    return this.ctx.storage.sql
      .exec<VersionRow>(
        "SELECT id, page_id, md_source, html_compiled, author_admin_id, note, summary, added_lines, removed_lines, created_at FROM versions WHERE page_id = ? ORDER BY created_at DESC",
        pageId,
      )
      .toArray();
  }

  getVersion(versionId: string): VersionRow | null {
    return this.ctx.storage.sql
      .exec<VersionRow>(
        "SELECT id, page_id, md_source, html_compiled, author_admin_id, note, summary, added_lines, removed_lines, created_at FROM versions WHERE id = ?",
        versionId,
      )
      .toArray()[0] ?? null;
  }

  /**
   * Recent versions across every page in this tenant's wiki, newest first.
   * Joins page metadata so the activity feed renders without an extra
   * round-trip per row. Hard-capped at 200 to bound the response size.
   */
  listRecentActivity(limit: number): ActivityRow[] {
    const cappedLimit = Math.min(Math.max(1, limit | 0), 200);
    return this.ctx.storage.sql
      .exec<ActivityRow>(
        `SELECT v.id AS version_id,
                v.page_id AS page_id,
                p.slug AS page_slug,
                p.title AS page_title,
                p.created_at AS page_created_at,
                p.visibility AS page_visibility,
                v.author_admin_id AS author_admin_id,
                v.note AS note,
                v.summary AS summary,
                v.added_lines AS added_lines,
                v.removed_lines AS removed_lines,
                v.diff_unified AS diff_unified,
                v.created_at AS created_at
         FROM versions v
         JOIN pages p ON p.id = v.page_id
         ORDER BY v.created_at DESC
         LIMIT ?`,
        cappedLimit,
      )
      .toArray();
  }

  // ---- write -------------------------------------------------------------

  /**
   * Upsert by slug. Creates the page if missing, otherwise updates title +
   * parent_id and appends a new version. Always inserts a fresh version row.
   *
   * Returns `previousMdSource` so the caller can compute a diff for the
   * AI-summary writer without an extra round-trip. Null on first save.
   */
  savePage(input: SavePageInput): {
    pageId: string;
    versionId: string;
    previousMdSource: string | null;
  } {
    const db = this.ctx.storage.sql;
    const now = Date.now();
    const slug = input.slug;
    const existing = db
      .exec<PageRow>("SELECT id, current_version_id FROM pages WHERE slug = ?", slug)
      .toArray()[0];

    const versionId = ulid();
    const versionRow = {
      id: versionId,
      md_source: input.mdSource,
      html_compiled: input.htmlCompiled,
      author_admin_id: input.authorAdminId,
      note: input.note ?? null,
      created_at: now,
    };

    const visibility: PageVisibility = input.visibility === "private" ? "private" : "public";
    let pageId: string;
    let previousMdSource: string | null = null;
    if (existing) {
      pageId = existing.id;
      // Read the previous version's markdown BEFORE inserting the new row,
      // so the summary writer can diff old → new.
      const prevVer = db
        .exec<{ md_source: string }>(
          "SELECT md_source FROM versions WHERE id = ?",
          existing.current_version_id,
        )
        .toArray()[0];
      previousMdSource = prevVer?.md_source ?? null;
      const delta = computeLineDelta(previousMdSource ?? "", input.mdSource);
      const diff = computeUnifiedDiff(previousMdSource ?? "", input.mdSource);
      db.exec(
        "INSERT INTO versions (id, page_id, md_source, html_compiled, author_admin_id, note, added_lines, removed_lines, diff_unified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        versionRow.id, pageId, versionRow.md_source, versionRow.html_compiled,
        versionRow.author_admin_id, versionRow.note,
        delta.added, delta.removed,
        diff || null,
        versionRow.created_at,
      );
      db.exec(
        "UPDATE pages SET title = ?, parent_id = ?, current_version_id = ?, visibility = ?, updated_at = ? WHERE id = ?",
        input.title, input.parentId ?? null, versionId, visibility, now, pageId,
      );
    } else {
      pageId = ulid();
      // First version on a new page → everything is "added", and there's no
      // previous to diff against so diff_unified stays NULL.
      const delta = computeLineDelta("", input.mdSource);
      db.exec(
        "INSERT INTO versions (id, page_id, md_source, html_compiled, author_admin_id, note, added_lines, removed_lines, diff_unified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        versionRow.id, pageId, versionRow.md_source, versionRow.html_compiled,
        versionRow.author_admin_id, versionRow.note,
        delta.added, delta.removed,
        null,
        versionRow.created_at,
      );
      db.exec(
        "INSERT INTO pages (id, slug, title, parent_id, current_version_id, visibility, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        pageId, slug, input.title, input.parentId ?? null, versionId, visibility, now, now,
      );
    }
    return { pageId, versionId, previousMdSource };
  }

  /**
   * Persist an AI-generated summary onto a version row. Best-effort — the
   * caller invokes this from `ctx.waitUntil(...)` after the save response
   * has already been returned, so failures must not throw or block.
   *
   * Returns `true` when a row was actually updated. If the version was
   * deleted between save and this call (or the id is unknown), the function
   * just no-ops.
   */
  updateVersionSummary(input: UpdateVersionSummaryInput): { updated: boolean } {
    const db = this.ctx.storage.sql;
    const cursor = db.exec(
      "UPDATE versions SET summary = ? WHERE id = ?",
      input.summary,
      input.versionId,
    );
    return { updated: cursor.rowsWritten > 0 };
  }

  /**
   * Revert a page to an older version. We do NOT mutate the version row —
   * we INSERT a new one carrying the older content. History stays append-only.
   */
  revertToVersion(input: RevertInput): { newVersionId: string } | null {
    const db = this.ctx.storage.sql;
    const oldVer = db
      .exec<{
        id: string;
        page_id: string;
        md_source: string;
        html_compiled: string;
      }>(
        "SELECT id, page_id, md_source, html_compiled FROM versions WHERE id = ?",
        input.versionId,
      )
      .toArray()[0];
    if (!oldVer || oldVer.page_id !== input.pageId) return null;

    // What's the current content? We need it to compute the revert's delta.
    const page = db
      .exec<{ current_version_id: string }>(
        "SELECT current_version_id FROM pages WHERE id = ?",
        input.pageId,
      )
      .toArray()[0];
    const currentMd = page
      ? db
          .exec<{ md_source: string }>(
            "SELECT md_source FROM versions WHERE id = ?",
            page.current_version_id,
          )
          .toArray()[0]?.md_source ?? ""
      : "";

    const newVersionId = ulid();
    const now = Date.now();
    const delta = computeLineDelta(currentMd, oldVer.md_source);
    const diff = computeUnifiedDiff(currentMd, oldVer.md_source);
    db.exec(
      "INSERT INTO versions (id, page_id, md_source, html_compiled, author_admin_id, note, added_lines, removed_lines, diff_unified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      newVersionId, input.pageId, oldVer.md_source, oldVer.html_compiled,
      input.authorAdminId, `revert to ${oldVer.id.slice(0, 8)}`,
      delta.added, delta.removed,
      diff || null,
      now,
    );
    db.exec(
      "UPDATE pages SET current_version_id = ?, updated_at = ? WHERE id = ?",
      newVersionId, now, input.pageId,
    );
    return { newVersionId };
  }
}

export type SavePageInput = {
  visibility?: PageVisibility;
  slug: string;
  title: string;
  parentId?: string | null;
  mdSource: string;
  htmlCompiled: string;
  authorAdminId: string;
  note?: string | null;
};

export type RevertInput = {
  pageId: string;
  versionId: string;
  authorAdminId: string;
};

export type UpdateVersionSummaryInput = {
  versionId: string;
  summary: string;
};
