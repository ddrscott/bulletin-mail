# Reference deployment: `bulletinmail.org`

This directory holds the per-instance configuration for the reference deployment of BulletinMail, run by the project maintainer at [bulletinmail.org](https://bulletinmail.org). Generic code in `workers/`, `packages/`, `cli/`, `apps/` reads every per-instance value from `instance.config.json` — never hard-codes it.

If you're forking BulletinMail to run your own instance, **do not edit this directory** in your fork. Instead:

```sh
cp -R deployments/bulletinmail.org deployments/<your-apex>
# then edit deployments/<your-apex>/instance.config.json
```

Your deployment script will read `deployments/<your-apex>/instance.config.json` instead of this one.

See [`docs/self-hosting.md`](../../docs/self-hosting.md) for the full operator setup, and PRD §19 / §20 for the rationale behind the three-layer separation.

## Files

- `instance.config.json` — the canonical per-deployment config. Schema in `packages/shared/instance.config.schema.json`.

## Deploying

From the repo root:

```sh
pnpm render-wrangler --instance bulletinmail.org
pnpm --filter "@bulletinmail/*" deploy
```

The first command materializes `workers/*/wrangler.generated.toml` with values from this directory; the second runs `wrangler deploy --config wrangler.generated.toml` in each Worker.
