# boilerplate-express-ts

> Express 5 · TypeScript 6 · PostgreSQL · JWT · OAuth 2.0 · Argon2 · Zod

Minimal but production-ready REST API starter. No framework magic — just TypeScript, Express, and pg.

## Stack

| Layer | Tech |
|-------|------|
| Framework | Express 5 |
| Language | TypeScript 6 |
| Database | PostgreSQL (node-postgres) |
| Auth | JWT + OAuth 2.0 (Passport) |
| Validation | Zod |
| Testing | Jest + Supertest |

## Quick Start

```bash
git clone https://github.com/Kojo-Brown/boilerplate-express-ts.git
cd boilerplate-express-ts
pnpm install
cp .env.example .env
docker-compose up postgres -d
pnpm db:migrate
pnpm dev  # http://localhost:4000/v1
```

## Supported Node versions

`engines.node` is `^22.12.0 || ^24.0.0` — the two Node release lines still under
LTS. CI runs lint, typecheck, test, and build against **both** majors, so a
change that only works on one of them fails before it reaches `main`.

Warnings are failures in CI, on every major:

| Source of warning | How it fails the build |
|-------------------|------------------------|
| Unmet peer dependency ranges | `pnpm install --strict-peer-dependencies` |
| ESLint rules configured as `warn` | `pnpm lint` runs `eslint --max-warnings=0` |
| Node runtime deprecations (ours or a dependency's) | `NODE_OPTIONS=--throw-deprecation` on every gate step |

To reproduce a CI failure locally, run the gate with the same flags:

```bash
pnpm install --frozen-lockfile --strict-peer-dependencies
NODE_OPTIONS=--throw-deprecation pnpm test
```

## Design notes
- [SOLID audit](./docs/solid.md) — the five principles applied to this codebase,
  with the before/after of each refactor they produced.
- [Factory + Registry](./docs/provider-registry.md) — `ProviderRegistry`, the
  compile-time exhaustiveness it buys, and the storage adapters behind
  `STORAGE_DRIVER`.

## Spec Progress
See [SPEC.md](./SPEC.md).
