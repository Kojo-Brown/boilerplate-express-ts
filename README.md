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

## Spec Progress
See [SPEC.md](./SPEC.md).
