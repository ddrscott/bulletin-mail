/**
 * Unified search over mail archive + wiki via Cloudflare Vectorize +
 * Workers AI embeddings (community hub 4/5).
 *
 * Design:
 *   - One Vectorize index per instance; every vector carries `tenant_id`
 *     metadata and every query filters on it, so results can never cross
 *     tenants. Group-level visibility (archive_visibility / membership) is
 *     enforced by the caller AFTER the query, in code, against D1 — the
 *     vector store is a candidate generator, not an authority.
 *   - Vector ids are namespaced: `msg:<messageId>` and
 *     `wiki:<tenantId>:<pageSlug>`. Wiki re-saves overwrite in place
 *     (upsert); messages are append-only.
 *   - The binding is OPTIONAL. Operators enable it per instance
 *     (`features.searchEnabled` in the overlay → render-wrangler keeps the
 *     [[vectorize]] block). When `env.SEARCH_INDEX` or `env.AI` is absent,
 *     callers skip indexing and hide the search UI. Indexing is always
 *     fire-and-forget (ctx.waitUntil) and never blocks the mail path or a
 *     wiki save.
 *
 * One-time setup for an instance that enables search:
 *   wrangler vectorize create bulletinmail-search --dimensions=768 --metric=cosine
 *   wrangler vectorize create-metadata-index bulletinmail-search --property-name=tenant_id --type=string
 *
 * Model: @cf/baai/bge-base-en-v1.5 (768 dims). Free-allocation friendly at
 * small-org scale — one embedding call per inbound message / wiki save.
 */

/** Embedding model id. 768-dimension output; keep in sync with the
 *  `--dimensions=768` used when creating the Vectorize index. */
export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

/** Hard cap on text fed to the embedder. bge-base truncates around 512
 *  tokens anyway; capping the string bounds the request payload. */
export const EMBED_TEXT_MAX_CHARS = 4000;

/** Snippet stored in vector metadata so the results page renders without a
 *  per-hit content fetch. */
export const SNIPPET_MAX_CHARS = 240;

// Structural types for the two bindings we touch. Kept minimal (rather than
// importing @cloudflare/workers-types' Ai / VectorizeIndex) so this module
// compiles identically in every workspace package regardless of the
// workers-types version it pins.
export type EmbeddingAi = {
  run: (model: string, input: unknown) => Promise<unknown>;
};

export type SearchVectorMetadata = {
  tenant_id: string;
  type: "message" | "wiki";
  title: string;
  snippet: string;
  /** messages only */
  group_id?: string;
  thread_id?: string;
  /** wiki only */
  slug?: string;
  visibility?: "public" | "private";
  created_at: number;
};

export type SearchVector = {
  id: string;
  values: number[];
  metadata: SearchVectorMetadata;
};

export type SearchMatch = {
  id: string;
  score: number;
  metadata?: Partial<SearchVectorMetadata>;
};

export type SearchIndex = {
  upsert: (vectors: SearchVector[]) => Promise<unknown>;
  query: (
    vector: number[],
    options: {
      topK?: number;
      filter?: Record<string, unknown>;
      returnMetadata?: boolean | string;
    },
  ) => Promise<{ matches: SearchMatch[] }>;
};

// ---- text preparation -------------------------------------------------------

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Subject + body → one embeddable document. */
export function buildMessageDocText(subject: string, bodyText: string | null): string {
  return collapse(`${subject}\n${bodyText ?? ""}`).slice(0, EMBED_TEXT_MAX_CHARS);
}

/** Title + markdown source → one embeddable document. Markdown syntax is
 *  left in place — bge handles it fine and stripping it buys nothing. */
export function buildWikiDocText(title: string, mdSource: string): string {
  return collapse(`${title}\n${mdSource}`).slice(0, EMBED_TEXT_MAX_CHARS);
}

export function makeSnippet(text: string | null): string {
  const s = collapse(text ?? "");
  return s.length <= SNIPPET_MAX_CHARS ? s : s.slice(0, SNIPPET_MAX_CHARS - 1).trimEnd() + "…";
}

// ---- embedding --------------------------------------------------------------

/**
 * Embed a batch of texts. Returns one 768-float vector per input, in order.
 * Throws on any model failure — callers decide whether that's fatal (backfill
 * surfaces it) or swallowed (ingest hooks log + move on).
 */
export async function embedTexts(ai: EmbeddingAi, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const result = (await ai.run(EMBEDDING_MODEL, { text: texts })) as {
    data?: number[][];
  };
  if (!result?.data || result.data.length !== texts.length) {
    throw new Error(
      `embedding model returned ${result?.data?.length ?? 0} vectors for ${texts.length} inputs`,
    );
  }
  return result.data;
}

// ---- indexing ---------------------------------------------------------------

export type MessageIndexInput = {
  messageId: string;
  tenantId: string;
  groupId: string;
  threadId: string;
  subject: string;
  bodyText: string | null;
  receivedAt: number;
};

export function messageVectorId(messageId: string): string {
  return `msg:${messageId}`;
}

export function wikiVectorId(tenantId: string, slug: string): string {
  return `wiki:${tenantId}:${slug}`;
}

/**
 * Build the vector rows for a batch of messages (one embedding call). Pure
 * except for the AI call — the caller upserts.
 */
export async function buildMessageVectors(
  ai: EmbeddingAi,
  messages: MessageIndexInput[],
): Promise<SearchVector[]> {
  const vectors = await embedTexts(
    ai,
    messages.map((m) => buildMessageDocText(m.subject, m.bodyText)),
  );
  return messages.map((m, i) => ({
    id: messageVectorId(m.messageId),
    values: vectors[i]!,
    metadata: {
      tenant_id: m.tenantId,
      type: "message",
      title: m.subject || "(no subject)",
      snippet: makeSnippet(m.bodyText),
      group_id: m.groupId,
      thread_id: m.threadId,
      created_at: m.receivedAt,
    },
  }));
}

/**
 * Index one inbound/web message. Best-effort: catches and logs every
 * failure. Intended for `ctx.waitUntil(...)` on the ingest path — indexing
 * must never block or fail mail delivery.
 */
export async function tryIndexMessage(
  ai: EmbeddingAi | undefined,
  index: SearchIndex | undefined,
  input: MessageIndexInput,
): Promise<void> {
  if (!ai || !index) return;
  try {
    const rows = await buildMessageVectors(ai, [input]);
    await index.upsert(rows);
  } catch (err) {
    console.error(`search: indexing message ${input.messageId} failed`, err);
  }
}

export type WikiIndexInput = {
  tenantId: string;
  slug: string;
  title: string;
  mdSource: string;
  visibility: "public" | "private";
  updatedAt: number;
};

/**
 * Index (or re-index — upsert by stable id) one wiki page. Best-effort,
 * same contract as tryIndexMessage.
 */
export async function tryIndexWikiPage(
  ai: EmbeddingAi | undefined,
  index: SearchIndex | undefined,
  input: WikiIndexInput,
): Promise<void> {
  if (!ai || !index) return;
  try {
    const [values] = await embedTexts(ai, [buildWikiDocText(input.title, input.mdSource)]);
    await index.upsert([
      {
        id: wikiVectorId(input.tenantId, input.slug),
        values: values!,
        metadata: {
          tenant_id: input.tenantId,
          type: "wiki",
          title: input.title,
          snippet: makeSnippet(input.mdSource),
          slug: input.slug,
          visibility: input.visibility,
          created_at: input.updatedAt,
        },
      },
    ]);
  } catch (err) {
    console.error(`search: indexing wiki page ${input.slug} failed`, err);
  }
}

// ---- query ------------------------------------------------------------------

/**
 * Embed the query text and run a tenant-scoped Vectorize query. Returns raw
 * matches (best-first); the caller MUST apply group/visibility filtering
 * before rendering anything. Throws on model/index failure — the search UI
 * shows an error state rather than silently returning nothing.
 */
export async function searchTenant(
  ai: EmbeddingAi,
  index: SearchIndex,
  tenantId: string,
  query: string,
  topK = 20,
): Promise<SearchMatch[]> {
  const [vector] = await embedTexts(ai, [collapse(query).slice(0, EMBED_TEXT_MAX_CHARS)]);
  const result = await index.query(vector!, {
    topK,
    filter: { tenant_id: tenantId },
    returnMetadata: "all",
  });
  return result.matches ?? [];
}
