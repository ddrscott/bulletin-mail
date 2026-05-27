import { describe, expect, it } from "vitest";
import {
  buildSessionClearCookie,
  buildSessionSetCookie,
  issueSessionCookie,
  readSessionCookieFromHeader,
  SESSION_COOKIE_NAME,
  verifySessionCookie,
} from "../src/worker/lib/session.js";

const SECRET = "test-secret-1234567890abcdef";

describe("session cookie", () => {
  it("round-trips: issue then verify recovers adminId", async () => {
    const value = await issueSessionCookie("a_abc", SECRET);
    const payload = await verifySessionCookie(value, SECRET);
    expect(payload?.adminId).toBe("a_abc");
    expect(payload?.exp).toBeGreaterThan(Date.now());
  });

  it("rejects a cookie signed with a different secret", async () => {
    const value = await issueSessionCookie("a_abc", SECRET);
    expect(await verifySessionCookie(value, "different-secret")).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const value = await issueSessionCookie("a_abc", SECRET);
    // Flip a byte in the payload portion — different b64url char keeps it valid base64.
    const [payloadB64, sigB64] = value.split(".") as [string, string];
    const tampered = (payloadB64.slice(0, -1) + (payloadB64.endsWith("A") ? "B" : "A")) + "." + sigB64;
    expect(await verifySessionCookie(tampered, SECRET)).toBeNull();
  });

  it("rejects an expired cookie", async () => {
    const value = await issueSessionCookie("a_abc", SECRET);
    // 8 days in the future — past the 7-day lifetime.
    const future = Date.now() + 8 * 24 * 60 * 60 * 1000;
    expect(await verifySessionCookie(value, SECRET, future)).toBeNull();
  });

  it("rejects a malformed cookie", async () => {
    expect(await verifySessionCookie("not.a.real.cookie", SECRET)).toBeNull();
    expect(await verifySessionCookie("garbage", SECRET)).toBeNull();
    expect(await verifySessionCookie("", SECRET)).toBeNull();
  });

  it("sets HttpOnly, Secure, SameSite=Lax on the cookie", () => {
    const header = buildSessionSetCookie("abc.def");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header.startsWith(`${SESSION_COOKIE_NAME}=abc.def`)).toBe(true);
  });

  it("clear cookie sets Max-Age=0", () => {
    expect(buildSessionClearCookie()).toMatch(/Max-Age=0/);
  });

  it("parses our cookie out of a Cookie header with other entries", () => {
    const header = `theme=dark; ${SESSION_COOKIE_NAME}=abc.def; tracking=xyz`;
    expect(readSessionCookieFromHeader(header)).toBe("abc.def");
  });

  it("returns null when our cookie is absent", () => {
    expect(readSessionCookieFromHeader("theme=dark; foo=bar")).toBeNull();
    expect(readSessionCookieFromHeader(null)).toBeNull();
    expect(readSessionCookieFromHeader(undefined)).toBeNull();
  });
});
