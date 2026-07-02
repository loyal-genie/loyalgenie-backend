# LoyalGenie Backend

Node.js + Express API with **Supabase Postgres**, **Cloudflare R2** (images), and **Supabase Realtime** (PIN + redemptions).

## Quick start

```bash
cp .env.example .env   # add Supabase + R2 credentials
npm install
npm run verify:infra   # test DB + R2 connection
npm run db:apply-schema
npm run db:enable-realtime   # Phase 4 — PIN + redemption push
npm run db:drop-blobs        # Phase 4 — remove legacy base64 columns (after R2 backfill)
npm run dev            # http://localhost:4000
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start API with hot reload |
| `npm start` | Start compiled API (production) |
| `npm run build` | Compile TypeScript |
| `npm run verify:infra` | Verify Supabase Postgres + R2 credentials |
| `npm run db:apply-schema` | Apply Postgres schema (run once per environment) |
| `npm run db:apply-rewards-module` | Apply rewards module migration (run once per environment) |
| `npm run db:import -- file.db [--fresh]` | Import Turso SQLite → Supabase + upload images to R2 |
| `npm run db:enable-realtime` | Enable Supabase Realtime on `campaigns` + `customer_rewards` |
| `npm run db:drop-blobs` | Drop `*_data` base64 columns (after images are in R2) |
| `npm run test:shake` | Shake win flow integration test |
| `npm run test:loyalty:e2e` | Check-in loyalty E2E test |

## Environment

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Supabase Postgres URI (Session pooler, port 5432). URL-encode `@` in password as `%40`. |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Backend service role key |
| `SUPABASE_ANON_KEY` | Public anon key (used by frontend Realtime) |
| `R2_*` | Cloudflare R2 credentials for image uploads |
| `PORT` | API port (default 4000) |
| `JWT_SECRET` | Auth token signing |
| `MSG91_*` | OTP SMS/email |

## Frontend env (Realtime)

Add to `frontend/.env`:

```env
VITE_SUPABASE_URL=https://xxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=your_anon_key
```

Without these, vendor PIN and redemption queue fall back to polling (still works).

## Database

- Schema: `supabase/migrations/001_initial_schema.sql`
- Realtime: `supabase/migrations/002_realtime.sql`
- Drop blobs: `supabase/migrations/003_drop_blob_columns.sql`
- Rewards module: `supabase/migrations/005_rewards_module.sql`
- Migrations are **not** run on server startup — use the npm scripts below
- **Import Turso export (data + images):**
  ```bash
  npm run db:apply-schema
  npm run db:import -- "../loyalgenie (1).db" --fresh
  npm run db:enable-realtime
  npm run db:drop-blobs
  ```

## Production notes

- Keep API **always warm** (Render free tier sleeps = 5–30s cold start — use paid or min 1 instance)
- Images served from R2 CDN, not API
- Discover list should be **< 500ms** / **< 100KB** with URL-only images

## API

```
GET  /api/health
POST /api/onboarding/complete
POST /api/uploads/presign
GET  /api/campaigns/public/businesses
GET  /api/campaigns/public/businesses/:id/states
... (see routes/)
```
