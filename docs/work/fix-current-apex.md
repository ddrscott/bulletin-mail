# Fix `currentApex()` in admin SPA — apex collapse broke it

## Problem

The "New tenant" form preview shows the wrong subdomain URL. When the slug `demo1` is entered, the preview reads:

```
→ https://demo1.org/admin/ · sign-in link emailed to ddrscott@gmail.com
```

It should read:

```
→ https://demo1.bulletinmail.org/admin/ · sign-in link emailed to ddrscott@gmail.com
```

The apex domain (`bulletinmail.org`) is being chopped down to just `org`.

## Root cause

`admin/dom.ts` has a `currentApex()` helper that strips the first DNS label off `location.host`:

```ts
export function currentApex(): string {
  return location.host.replace(/^[^.]+\./, "");
}
```

That worked when admin was served at `app.<apex>` (the pre-collapse layout). On `app.bulletinmail.org`, stripping the leading label gives `bulletinmail.org`. Correct.

After the admin-collapse refactor, the SPA is served at the bare apex `<apex>/admin/`. On `bulletinmail.org`, stripping the leading label gives `org`. Wrong.

The helper is used in multiple places:
- `admin/views/site-home.ts:33` — `currentApex()` then later `https://${slug}.${apex}/admin/`
- `admin/views/group.ts:39` — `${group.name}@${me.tenant.slug}.${apex}` (list address preview)
- `admin/views/home.ts:111,157` — same pattern for tenant list addresses

All of these break when the SPA is loaded from the apex. They likely still work when the SPA is loaded from a tenant subdomain (`<tenant>.<apex>/admin/`), but break on the site-admin context.

## Acceptance criteria

- `currentApex()` returns the correct apex domain regardless of which host the SPA loaded from (apex, tenant subdomain).
- The "New tenant" preview shows `https://<slug>.<apex>/admin/` (e.g. `https://demo1.bulletinmail.org/admin/`).
- Group list addresses on the tenant home (`<group>@<tenant>.<apex>`) still render correctly when the SPA loads on a tenant subdomain.
- Tenant rows on the site-admin home link to the correct tenant subdomain URL.

## Recommended fix

The client can't reliably derive the apex by counting dots — apex domains may already have a subdomain in their name (e.g. `lists.example.org`). The right move is to make the server tell the SPA.

Add `apexDomain` to the `/api/me` response (server-side: `server/routes/admin/me.ts`), then store it in the SPA's bootstrap data and use it in place of `currentApex()`. Delete the helper.

Alternative (worse but smaller change): hard-code apex detection by classifyHost-style logic in the SPA — but the SPA doesn't have access to `InstanceConfig`, so it'd need its own config-passing mechanism. Not worth it.

## Relevant files

- `admin/dom.ts` — `currentApex()` helper, ~7 lines, delete after refactor.
- `admin/views/site-home.ts:33,144` — currently uses `currentApex()`.
- `admin/views/group.ts:39` — uses `currentApex()`.
- `admin/views/home.ts:111,157` — uses `currentApex()`.
- `server/routes/admin/me.ts` — add `apexDomain` to the response payload.
- `admin/api.ts` — update the `/api/me` response type to include `apexDomain`.

## Constraints

- Do NOT hardcode `bulletinmail.org` anywhere in `admin/` or `server/` — generic code must read from `InstanceConfig` (existing PRD §20 rule, enforced by `scripts/check-no-instance-leakage.sh`).
- The fix should work for forks running under their own apex without code changes.
