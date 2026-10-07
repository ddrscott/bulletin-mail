/**
 * Tests for the apex /contact form's Turnstile human check.
 *
 * Approach mirrors tenant-docs.test.ts: mount the route on a bare Hono app.
 * Global fetch is stubbed so we can see what reached siteverify and — the
 * point of the check — whether anything reached the Discord webhook.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mountContact } from "../server/routes/contact.js";
import type { AppVariables, Env } from "../server/types.js";
import type { InstanceConfig } from "@bulletinmail/shared";

const WEBHOOK = "https://discord.example/webhook";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const KEYS = { TURNSTILE_SITE_KEY: "site-key-123", TURNSTILE_SECRET_KEY: "secret-456" };

const config = { productName: "Example Lists" } as InstanceConfig;

function buildApp() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("config", config);
    await next();
  });
  mountContact(app);
  return app;
}

/** Stub fetch; siteverify answers `success`, Discord answers 204. */
function stubFetch(success: boolean) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(String(url));
    if (String(url) === SITEVERIFY) return Response.json({ success });
    return new Response(null, { status: 204 });
  });
  return calls;
}

function post(env: Record<string, string>, fields: Record<string, string>) {
  const body = new URLSearchParams({
    name: "Pat",
    email: "pat@example.com",
    reason: "other",
    message: "Hello there",
    ...fields,
  });
  return buildApp().request(
    "/contact",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    { DISCORD_WEBHOOK: WEBHOOK, ...env },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("GET /contact", () => {
  it("embeds the Turnstile widget when a site key is configured", async () => {
    const res = await buildApp().request("/contact", {}, KEYS);
    const html = await res.text();
    expect(html).toContain('class="cf-turnstile" data-sitekey="site-key-123"');
    expect(html).toContain("challenges.cloudflare.com/turnstile/v0/api.js");
  });

  it("stays script-free when Turnstile isn't configured", async () => {
    const res = await buildApp().request("/contact", {}, {});
    const html = await res.text();
    expect(html).not.toContain('class="cf-turnstile"');
    expect(html).not.toContain("<script");
  });
});

describe("POST /contact", () => {
  it("rejects a submission with no token and never calls Discord", async () => {
    const calls = stubFetch(true);
    const res = await post(KEYS, {});
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain("Human verification failed");
    // Draft is preserved and the widget is back for another try.
    expect(html).toContain("Hello there");
    expect(html).toContain('class="cf-turnstile"');
    expect(calls).toEqual([]);
  });

  it("rejects a token siteverify refuses and never calls Discord", async () => {
    const calls = stubFetch(false);
    const res = await post(KEYS, { "cf-turnstile-response": "bad-token" });
    expect(res.status).toBe(403);
    expect(calls).toEqual([SITEVERIFY]);
  });

  it("forwards to Discord once siteverify accepts the token", async () => {
    const calls = stubFetch(true);
    const res = await post(KEYS, { "cf-turnstile-response": "good-token" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Thanks");
    expect(calls).toEqual([SITEVERIFY, WEBHOOK]);
  });

  it("checks the human before the fields", async () => {
    const calls = stubFetch(true);
    const res = await post(KEYS, { email: "nope" });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("bypasses the check when the secret is unset (dev mode)", async () => {
    const calls = stubFetch(true);
    const res = await post({}, {});
    expect(res.status).toBe(200);
    expect(calls).toEqual([WEBHOOK]);
  });
});
