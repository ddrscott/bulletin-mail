import { describe, expect, it } from "vitest";
import {
  extractJson,
  isAlreadyAppliedError,
  parseDatabaseName,
} from "../scripts/db-migrate.js";

describe("isAlreadyAppliedError", () => {
  it("matches SQLite messages for every additive statement form", () => {
    // ALTER TABLE ... ADD COLUMN
    expect(
      isAlreadyAppliedError("SqliteError: duplicate column name: code"),
    ).toBe(true);
    // CREATE TABLE
    expect(
      isAlreadyAppliedError("Error: table tenants already exists [code: 7500]"),
    ).toBe(true);
    // CREATE INDEX
    expect(
      isAlreadyAppliedError("index idx_magic_links_code already exists"),
    ).toBe(true);
  });

  it("does not match genuine failures", () => {
    expect(isAlreadyAppliedError("no such table: tenants")).toBe(false);
    expect(isAlreadyAppliedError('near "CRATE": syntax error')).toBe(false);
    expect(
      isAlreadyAppliedError("A request to the Cloudflare API failed."),
    ).toBe(false);
    expect(isAlreadyAppliedError("UNIQUE constraint failed: tenants.slug")).toBe(
      false,
    );
  });
});

describe("parseDatabaseName", () => {
  it("reads database_name from the [[d1_databases]] block", () => {
    const toml = [
      'name = "bulletinmail-web"',
      "[[d1_databases]]",
      'binding = "DB"',
      'database_name = "bulletinmail"',
      'database_id = "b78507ff-0000-0000-0000-000000000000"',
    ].join("\n");
    expect(parseDatabaseName(toml)).toBe("bulletinmail");
  });

  it("returns null when no block exists", () => {
    expect(parseDatabaseName('name = "x"')).toBeNull();
  });
});

describe("extractJson", () => {
  it("parses wrangler --json output surrounded by banner noise", () => {
    const noisy =
      "▲ [WARNING] update available\n" +
      '[{"results":[{"name":"0001_init.sql"}],"success":true}]\n' +
      "🪵 Logs were written";
    expect(extractJson(noisy)).toEqual([
      { results: [{ name: "0001_init.sql" }], success: true },
    ]);
  });

  it("throws on output with no JSON array", () => {
    expect(() => extractJson("✘ ERROR something broke")).toThrow(/no JSON/);
  });
});
