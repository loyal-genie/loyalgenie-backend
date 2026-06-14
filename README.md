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

## API

```
GET  /api/health
POST /api/onboarding/complete
GET  /api/onboarding/business/:id
GET  /api/onboarding/qr/:slug
```
