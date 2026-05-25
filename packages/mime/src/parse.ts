/**
 * Wraps postal-mime to parse inbound RFC 5322 messages.
 *
 * Generic code only — knows nothing about any specific instance. Inbound
 * worker passes `message.raw` from Cloudflare Email Routing; we normalize
 * to a ParsedMessage shape the rest of the pipeline can rely on.
 *
 * Also enforces the PRD §8.1 attachment rule: messages with dangerous
 * extensions (.exe .bat .scr .js .vbs .com .pif .cmd .jar) have those
 * attachments removed before we ever persist the message.
 */

import PostalMime from "postal-mime";

export type ParsedMessage = {
  fromEmail: string;
  fromName: string | null;
  toAddresses: string[];
  subject: string;
  messageId: string | null;       // sender's original Message-ID, brackets stripped
  inReplyTo: string | null;       // single id, brackets stripped
  references: string[];           // ordered ancestors, brackets stripped
  bodyText: string | null;
  bodyHtml: string | null;
  attachments: ParsedAttachment[];
  strippedAttachments: string[];  // filenames removed for being dangerous
  receivedAt: number;
};

export type ParsedAttachment = {
  filename: string;
  contentType: string;
  contentId: string | null;
  bytes: Uint8Array;
};

const DANGEROUS_EXTENSIONS = new Set([
  ".exe", ".bat", ".scr", ".js", ".vbs", ".com", ".pif", ".cmd", ".jar",
  // Bonus: extensions that have caused real-world abuse and that no legitimate
  // small-org mailing list traffic should contain.
  ".dll", ".ps1", ".vbe", ".wsf", ".lnk", ".reg", ".msi",
]);

function isDangerousFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return false;
  return DANGEROUS_EXTENSIONS.has(lower.slice(dot));
}

/** Strip surrounding `<...>` from an RFC 5322 msg-id token. */
function stripBrackets(id: string): string {
  return id.trim().replace(/^<|>$/g, "");
}

/** Tokenize the References header (whitespace-separated msg-ids w/ brackets). */
function parseReferences(value: string | undefined | null): string[] {
  if (!value) return [];
  const tokens = value.match(/<[^>]+>/g);
  if (!tokens) return [];
  return tokens.map(stripBrackets);
}

async function rawToUint8(raw: ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  const reader = (raw as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const chunk of chunks) {
    out.set(chunk, off);
    off += chunk.byteLength;
  }
  return out;
}

export async function parseMessage(
  raw: ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer,
  receivedAt: number = Date.now(),
): Promise<ParsedMessage> {
  const bytes = await rawToUint8(raw);
  const parsed = await PostalMime.parse(bytes);

  const fromEmail = parsed.from?.address ?? "";
  const fromName = parsed.from?.name?.trim() || null;

  const toAddresses: string[] = [];
  for (const addr of parsed.to ?? []) {
    if (addr?.address) toAddresses.push(addr.address);
  }

  const messageId = parsed.messageId ? stripBrackets(parsed.messageId) : null;
  const inReplyTo = parsed.inReplyTo ? stripBrackets(parsed.inReplyTo) : null;
  const references = parseReferences(parsed.references);

  const attachments: ParsedAttachment[] = [];
  const strippedAttachments: string[] = [];

  for (const att of parsed.attachments ?? []) {
    const filename = att.filename ?? "unnamed";
    if (isDangerousFilename(filename)) {
      strippedAttachments.push(filename);
      continue;
    }
    let bytes: Uint8Array;
    if (att.content instanceof Uint8Array) {
      bytes = att.content;
    } else if (att.content instanceof ArrayBuffer) {
      bytes = new Uint8Array(att.content);
    } else if (typeof att.content === "string") {
      // postal-mime may return base64-encoded string for some attachments
      bytes = Uint8Array.from(atob(att.content), (c) => c.charCodeAt(0));
    } else {
      // Defensive: skip if we can't materialize bytes
      continue;
    }
    attachments.push({
      filename,
      contentType: att.mimeType ?? "application/octet-stream",
      contentId: att.contentId ? stripBrackets(att.contentId) : null,
      bytes,
    });
  }

  return {
    fromEmail,
    fromName,
    toAddresses,
    subject: (parsed.subject ?? "").trim(),
    messageId,
    inReplyTo,
    references,
    bodyText: parsed.text?.trim() || null,
    bodyHtml: parsed.html?.trim() || null,
    attachments,
    strippedAttachments,
    receivedAt,
  };
}
