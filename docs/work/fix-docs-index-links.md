# Fix broken Diátaxis section links on /docs/ landing page

## Problem

On the live site, `https://bulletinmail.org/docs/` renders the old committed `docs/index.md`, whose four section links — `/docs/tutorial/`, `/docs/how-to/`, `/docs/reference/`, `/docs/explanation/` — 404 (no section index pages exist).

An **uncommitted local edit to `docs/index.md` already fixes this** (user-authored, deliberate): it removes the four broken links and replaces them with per-section headings that list the actual doc pages. The user has chosen this approach over sidebar-highlight behavior or creating section index routes. The task is to finish and commit that edit — do NOT revert or rewrite it wholesale.

## Acceptance Criteria

- The current uncommitted `docs/index.md` content is preserved as the basis (verify with `git diff docs/index.md` before touching it; if the working tree is clean because it was committed in the meantime, just do the gap-fill below).
- Gap-fill: the How-to section must also list the two pages written after the user's edit:
  - `docs/how-to/archive.md` (member archive)
  - `docs/how-to/ai-features.md` (AI features)
  Match the existing entry style (bold link + one-line description).
- Link-check every `/docs/...` href in `docs/index.md` against files that actually exist under `docs/` (the four old section links must be gone; no new dead links introduced).
- Confirm how doc URLs map to files (e.g. `/docs/how-to/self-host/` → `docs/how-to/self-host.md`) by reading the docs-serving code in `server/` before assuming the URL scheme.
- Commit `docs/index.md` (this is the one file every prior worker deliberately left unstaged — committing it is now the point of this task).

## Relevant Files

- `docs/index.md` — the uncommitted user edit; the deliverable.
- `docs/how-to/archive.md`, `docs/how-to/ai-features.md` — pages to add to the list.
- `server/` docs-serving routes — to verify the URL scheme only; no server changes expected.

## Constraints

- Docs-only change; no server/route/JS changes.
- Do not create `/docs/tutorial/` etc. section index pages — that approach was considered and rejected.
- Note in the commit message that this fixes the live 404s once deployed (the fix reaches production only with the next deploy, which is tracked separately).
