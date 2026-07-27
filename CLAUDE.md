# boilerplate-express-ts — Agent Instructions

## What this repo is
Production-grade Express 5 + TypeScript 6 REST API boilerplate. Spec-driven and PR-driven: one `SPEC.md` item per run.

## Your job (scheduled agent, every 4h)
1. `git checkout main && git pull --ff-only origin main`
2. Read `SPEC.md`, take the **first** `- [ ]` item. Phase 0 items always win.
3. `git checkout -b <type>/<kebab-slug>` (`feat`/`fix`/`chore`/`ci`/`docs`)
4. Implement it completely — source, types, tests, docs.
5. Run every gate locally; **all must pass** before pushing:
   ```
   pnpm install
   pnpm typecheck
   pnpm lint
   pnpm test
   pnpm build
   ```
6. Commit, `git push -u origin <branch>`, then `gh pr create`.
7. `gh pr checks --watch` → **merge only if every check is green**:
   `gh pr merge --squash --delete-branch`
8. Pull main, mark the item `- [x]` in `SPEC.md`, update
   `../PROGRESS.md`, push as a `chore:` commit.

If a check fails, fix forward on the same branch. Never merge red. Never
weaken a test or lower a threshold to force green — if a gate is genuinely
wrong, change it deliberately and say why in the PR.

## Secrets
Never commit real credentials, tokens, keys, or `.env` files. Placeholders in
`.env.example` only; CI reads from the GitHub secret store. Test fixtures must
look obviously fake. Scan `git diff --cached` before every push.

## Conventions
- Path alias `@/` maps to `src/`
- All routes under `/v1/` via the router factory
- Validation is Zod middleware at the edge; handlers assume parsed input
- Errors go through the `AppError` + global error handler, never `res.status(500)` inline
- Repositories extend the typed CRUD base class; no raw SQL in route handlers

See `../ROUTINE.md` for the full workflow.
