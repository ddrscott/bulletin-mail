#!/usr/bin/env -S npx tsx
/**
 * db-migrate — apply packages/db/migrations/*.sql to a D1 database, in order,
 * exactly once, with applied-migration tracking.
 *
 * Usage:
 *   pnpm db:migrate                  # apply pending migrations to the remote DB
 *   pnpm db:migrate:local            # same, against the local dev DB
 *   pnpm db:migrate -- --status      # show applied / adopted / pending
 *   pnpm db:migrate -- --dry-run     # list what would run, change nothing
 *   ... -- --config <path>           # override the wrangler config file
 *
 * Tracking:
 *   Applied migrations are recorded in a `schema_migrations` table
 *   (name TEXT PRIMARY KEY, applied_at INTEGER, adopted INTEGER). Each
 *   migration file runs at most once; re-running the command is a no-op.
 *
 * Adoption (smooth transition for pre-tracking installs):
 *   Deployments that ran migrations by hand (before this script existed) have
 *   the schema but no tracking rows. Every migration in this repo is additive
 *   (CREATE TABLE / CREATE INDEX / ALTER TABLE ADD COLUMN), so when a
 *   migration fails with "already exists" / "duplicate column name" we know it
 *   was applied before tracking began: it is recorded with adopted = 1 and the
 *   run continues. A genuinely new migration never triggers this path.
 *   Invariant for future migration authors: keep migrations additive, or give
 *   destructive ones a fresh object name so the adopt heuristic stays sound.
 *
 * Remote runs use wrangler.generated.toml (real database_id — run
 * `pnpm render-wrangler --instance <apex>` first); local runs use the
 * committed wrangler.toml, matching `wrangler dev`'s local state.
 */

import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const MIGRATIONS_DIR = join("packages", "db", "migrations");
const TRACKING_TABLE = "schema_migrations";

/** True when a migration's failure means "its objects already exist", i.e. it
 *  was applied by hand before tracking existed. Matches SQLite's messages for
 *  every additive statement form used in this repo. */
export function isAlreadyAppliedError(message: string): boolean {
  return /duplicate column name|(table|index) .* already exists|already exists/i.test(
    message,
  );
}

/** Pull the database_name out of a wrangler TOML's [[d1_databases]] block. */
export function parseDatabaseName(toml: string): string | null {
  const m = toml.match(
    /\[\[d1_databases\]\][\s\S]*?database_name\s*=\s*"([^"]+)"/,
  );
  return m?.[1] ?? null;
}

/** Extract the JSON payload from wrangler --json output (which may be
 *  surrounded by upgrade banners on some versions — including bracketed
 *  noise like "[WARNING]", so each candidate "[" is tried until one
 *  parses). */
export function extractJson(stdout: string): unknown {
  const end = stdout.lastIndexOf("]");
  for (
    let start = stdout.indexOf("[");
    start !== -1 && start < end;
    start = stdout.indexOf("[", start + 1)
  ) {
    try {
      return JSON.parse(stdout.slice(start, end + 1));
    } catch {
      // banner bracket, not JSON — try the next candidate
    }
  }
  throw new Error(`no JSON found in wrangler output:\n${stdout}`);
}

type ExecResult = { ok: true; results: unknown[] } | { ok: false; error: string };

function d1Execute(
  opts: { db: string; config: string; remote: boolean },
  what: { command?: string; file?: string },
): ExecResult {
  const args = [
    "wrangler",
    "d1",
    "execute",
    opts.db,
    "--config",
    opts.config,
    opts.remote ? "--remote" : "--local",
    "--json",
  ];
  if (what.command !== undefined) args.push("--command", what.command);
  if (what.file !== undefined) args.push("--file", what.file);

  const proc = spawnSync("npx", args, { encoding: "utf8" });
  const out = (proc.stdout ?? "") + (proc.stderr ?? "");
  if (proc.status !== 0) return { ok: false, error: out };
  try {
    const payload = extractJson(proc.stdout ?? "") as Array<{
      results?: unknown[];
    }>;
    return { ok: true, results: payload[0]?.results ?? [] };
  } catch {
    // Non-SELECT statements sometimes emit no results block; success is enough.
    return { ok: true, results: [] };
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const local = args.includes("--local");
  const status = args.includes("--status");
  const dryRun = args.includes("--dry-run");
  const configIdx = args.indexOf("--config");
  const configPath =
    configIdx !== -1 && args[configIdx + 1]
      ? args[configIdx + 1]!
      : local
        ? "wrangler.toml"
        : "wrangler.generated.toml";

  if (!existsSync(configPath)) {
    console.error(
      configPath === "wrangler.generated.toml"
        ? "No wrangler.generated.toml — run `pnpm render-wrangler --instance <apex>` first."
        : `No config at ${configPath}`,
    );
    process.exit(2);
  }
  const db = parseDatabaseName(readFileSync(configPath, "utf8"));
  if (!db) {
    console.error(`No [[d1_databases]] database_name found in ${configPath}`);
    process.exit(2);
  }
  const target = { db, config: configPath, remote: !local };
  console.log(
    `database: ${db} (${local ? "local" : "remote"}, config: ${configPath})`,
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    console.log("no migration files found");
    return;
  }

  // Ensure the tracking table (idempotent; skipped on --dry-run so a dry run
  // truly writes nothing).
  if (!dryRun) {
    const ensure = d1Execute(target, {
      command:
        `CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (` +
        `name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL, ` +
        `adopted INTEGER NOT NULL DEFAULT 0)`,
    });
    if (!ensure.ok) {
      console.error(`failed to ensure ${TRACKING_TABLE}:\n${ensure.error}`);
      process.exit(1);
    }
  }

  const sel = d1Execute(target, {
    command: `SELECT name, adopted FROM ${TRACKING_TABLE} ORDER BY name`,
  });
  // On --dry-run against a pre-tracking DB the SELECT fails (no table yet):
  // treat as "nothing recorded".
  const appliedRows = sel.ok
    ? (sel.results as Array<{ name: string; adopted: number }>)
    : [];
  const applied = new Map(appliedRows.map((r) => [r.name, r.adopted]));

  if (status) {
    for (const f of files) {
      const state = !applied.has(f)
        ? "pending"
        : applied.get(f)
          ? "adopted"
          : "applied";
      console.log(`  ${state.padEnd(8)} ${f}`);
    }
    const pending = files.filter((f) => !applied.has(f)).length;
    console.log(`${files.length - pending} recorded, ${pending} pending`);
    return;
  }

  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) {
    console.log(`up to date — all ${files.length} migrations recorded`);
    return;
  }

  for (const f of pending) {
    if (dryRun) {
      console.log(`  would apply ${f}`);
      continue;
    }
    const run = d1Execute(target, { file: join(MIGRATIONS_DIR, f) });
    let adopted = 0;
    if (!run.ok) {
      if (!isAlreadyAppliedError(run.error)) {
        console.error(`  FAILED   ${f}\n${run.error}`);
        console.error(
          "Aborting — migrations before this one are recorded; fix and re-run.",
        );
        process.exit(1);
      }
      adopted = 1;
    }
    const name = f.replace(/'/g, "''");
    const record = d1Execute(target, {
      command:
        `INSERT INTO ${TRACKING_TABLE} (name, applied_at, adopted) ` +
        `VALUES ('${name}', ${Date.now()}, ${adopted})`,
    });
    if (!record.ok) {
      console.error(`  applied ${f} but failed to record it:\n${record.error}`);
      process.exit(1);
    }
    console.log(
      adopted
        ? `  adopted  ${f} (objects already exist — pre-tracking install)`
        : `  applied  ${f}`,
    );
  }
  if (dryRun) {
    console.log(`${pending.length} pending (dry run — nothing changed)`);
  } else {
    console.log(`done — ${pending.length} migration(s) recorded`);
  }
}

// Only run when invoked as a script (not when imported by tests).
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
