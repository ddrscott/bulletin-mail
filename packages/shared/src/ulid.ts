/**
 * ulid wrapper — centralizes the import so generic code never depends on
 * ulidx directly. Makes it easy to swap implementations or add prefixing
 * later without touching every call site.
 */

import { ulid as createUlid } from "ulidx";

export function newUlid(): string {
  return createUlid();
}
