# LoyalGenie Backend

Node.js + Express API with Turso (libSQL) PostgreSQL-compatible database.

## Quick start

```bash
cp .env.example .env   # add your Turso credentials
npm install
npm run dev            # http://localhost:4000
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start API with hot reload |
| `npm run db:migrate` | Apply database migrations |
| `npm run build` | Compile TypeScript |

## Environment

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Turso libSQL URL |
| `DATABASE_AUTH_TOKEN` | Turso auth token |
| `PORT` | API port (default 4000) |
| `FRONTEND_URL` | Used for QR join links |

## Features

- **Business onboarding** — `POST /api/onboarding/complete` — see [docs/features/business-onboarding.md](../docs/features/business-onboarding.md)

## Git

This folder **is its own git repo**. Always `cd` here before any git command — the parent `loyal-genie/` folder has no `.git`.

```bash
cd backend
git status                    # expect: ## main...origin/main
git pull origin main
git add .
git commit -m "your message"
git push origin main
```

| What | Value |
|------|-------|
| Branch | `main` → tracks `origin/main` |
| Remote | `git@github.com-personal:loyal-genie/loyalgenie-backend.git` |
| Deploy | Render pulls from this repo |

## API

```
GET  /api/health
POST /api/onboarding/complete
GET  /api/onboarding/business/:id
GET  /api/onboarding/qr/:slug
```
