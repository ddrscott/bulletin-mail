/**
 * Unified search unit tests — the pure/mockable parts:
 *   - doc-text + snippet preparation (caps, whitespace collapse)
 *   - vector id namespacing
 *   - buildMessageVectors metadata (tenant scoping payload)
 *   - searchTenant always sends the tenant_id filter
 *   - tryIndex* never throw (missing bindings, failing model)
 *   - wikiMatchToItem visibility gate (private pages admin-only)
 */

import { describe, expect, it } from "vitest";
import {
  buildMessageDocText,
  buildMessageVectors,
  buildWikiDocText,
  EMBED_TEXT_MAX_CHARS,
  makeSnippet,
  messageVectorId,
  searchTenant,
  SNIPPET_MAX_CHARS,
  tryIndexMessage,
  tryIndexWikiPage,
  wikiVectorId,
  type EmbeddingAi,
  type SearchIndex,
  type SearchVector,
} from "@bulletinmail/shared";
import { wikiMatchToItem } from "../server/archive/search.js";

const fakeAi = (dims = 4): EmbeddingAi => ({
  run: async (_model, input) => {
    const texts = (input as { text: string[] }).text;
    return { data: texts.map(() => new Array(dims).fill(0.5)) };
  },
});

type Captured = { upserted: SearchVector[][]; queries: unknown[] };
const fakeIndex = (): SearchIndex & { captured: Captured } => {
  const captured: Captured = { upserted: [], queries: [] };
  return {
    captured,
    upsert: async (vectors) => {
      captured.upserted.push(vectors);
    },
    query: async (_vector, options) => {
      captured.queries.push(options);
      return { matches: [] };
    },
  };
};

describe("doc text preparation", () => {
  it("collapses whitespace and joins subject + body", () => {
    expect(buildMessageDocText("Hello   world", "line1\n\nline2\t end")).toBe(
      "Hello world line1 line2 end",
    );
  });

  it("caps at EMBED_TEXT_MAX_CHARS", () => {
    const text = buildMessageDocText("s", "x".repeat(EMBED_TEXT_MAX_CHARS * 2));
    expect(text.length).toBe(EMBED_TEXT_MAX_CHARS);
  });

  it("handles a null body", () => {
    expect(buildMessageDocText("Subject only", null)).toBe("Subject only");
  });

  it("wiki doc includes the title", () => {
    expect(buildWikiDocText("Title", "# Heading\nbody")).toBe("Title # Heading body");
  });
});

describe("makeSnippet", () => {
  it("returns short text untouched", () => {
    expect(makeSnippet("short")).toBe("short");
  });

  it("caps long text with an ellipsis", () => {
    const s = makeSnippet("word ".repeat(200));
    expect(s.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
    expect(s.endsWith("…")).toBe(true);
  });

  it("handles null", () => {
    expect(makeSnippet(null)).toBe("");
  });
});

describe("vector ids", () => {
  it("namespaces messages and wiki pages distinctly", () => {
    expect(messageVectorId("abc")).toBe("msg:abc");
    expect(wikiVectorId("t_1", "index")).toBe("wiki:t_1:index");
  });
});

describe("buildMessageVectors", () => {
  it("carries tenant + group + thread metadata on every vector", async () => {
    const rows = await buildMessageVectors(fakeAi(), [
      {
        messageId: "m1",
        tenantId: "t_1",
        groupId: "g_1",
        threadId: "th_1",
        subject: "Bake sale",
        bodyText: "Saturday at 9am",
        receivedAt: 123,
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("msg:m1");
    expect(rows[0]!.metadata).toMatchObject({
      tenant_id: "t_1",
      type: "message",
      group_id: "g_1",
      thread_id: "th_1",
      title: "Bake sale",
      snippet: "Saturday at 9am",
      created_at: 123,
    });
  });

  it("throws when the model returns the wrong count", async () => {
    const badAi: EmbeddingAi = { run: async () => ({ data: [] }) };
    await expect(
      buildMessageVectors(badAi, [
        {
          messageId: "m1", tenantId: "t", groupId: "g", threadId: "th",
          subject: "s", bodyText: null, receivedAt: 0,
        },
      ]),
    ).rejects.toThrow(/vectors for 1 inputs/);
  });
});

describe("searchTenant", () => {
  it("always filters by tenant_id", async () => {
    const index = fakeIndex();
    await searchTenant(fakeAi(), index, "t_42", "potluck signup");
    expect(index.captured.queries).toHaveLength(1);
    expect(index.captured.queries[0]).toMatchObject({
      filter: { tenant_id: "t_42" },
      topK: 20,
    });
  });
});

describe("tryIndex* (best-effort contract)", () => {
  const msgInput = {
    messageId: "m1", tenantId: "t", groupId: "g", threadId: "th",
    subject: "s", bodyText: "b", receivedAt: 0,
  };

  it("no-ops when either binding is missing", async () => {
    const index = fakeIndex();
    await tryIndexMessage(undefined, index, msgInput);
    await tryIndexMessage(fakeAi(), undefined, msgInput);
    expect(index.captured.upserted).toHaveLength(0);
  });

  it("swallows model failures", async () => {
    const failing: EmbeddingAi = { run: async () => { throw new Error("model down"); } };
    const index = fakeIndex();
    await expect(tryIndexMessage(failing, index, msgInput)).resolves.toBeUndefined();
    await expect(
      tryIndexWikiPage(failing, index, {
        tenantId: "t", slug: "s", title: "T", mdSource: "m",
        visibility: "public", updatedAt: 0,
      }),
    ).resolves.toBeUndefined();
    expect(index.captured.upserted).toHaveLength(0);
  });

  it("upserts a wiki vector with a stable id", async () => {
    const index = fakeIndex();
    await tryIndexWikiPage(fakeAi(), index, {
      tenantId: "t_1", slug: "history", title: "Our History", mdSource: "# md",
      visibility: "private", updatedAt: 9,
    });
    expect(index.captured.upserted).toHaveLength(1);
    const vec = index.captured.upserted[0]![0]!;
    expect(vec.id).toBe("wiki:t_1:history");
    expect(vec.metadata).toMatchObject({
      tenant_id: "t_1", type: "wiki", slug: "history",
      title: "Our History", visibility: "private",
    });
  });
});

describe("wikiMatchToItem", () => {
  const match = (visibility: "public" | "private") => ({
    id: `wiki:t_1:secret`,
    score: 0.9,
    metadata: {
      tenant_id: "t_1", type: "wiki" as const, slug: "secret",
      title: "Secret Plans", snippet: "hush", visibility, created_at: 1,
    },
  });

  it("hides private pages from non-admins", () => {
    expect(wikiMatchToItem(match("private"), false)).toBeNull();
  });

  it("shows private pages to admins", () => {
    const item = wikiMatchToItem(match("private"), true);
    expect(item).toMatchObject({ kind: "wiki", href: "/wiki/secret", title: "Secret Plans" });
  });

  it("shows public pages to everyone", () => {
    expect(wikiMatchToItem(match("public"), false)).not.toBeNull();
  });

  it("rejects malformed metadata", () => {
    expect(wikiMatchToItem({ id: "wiki:t:x", score: 1 }, true)).toBeNull();
  });
});
