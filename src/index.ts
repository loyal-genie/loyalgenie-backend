import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { migrate } from './db/migrate.js'
import onboardingRoutes from './routes/onboarding.js'
import authRoutes from './routes/auth.js'
import businessRoutes from './routes/business.js'

dotenv.config()

const app = express()
const PORT = Number(process.env.PORT ?? 4000)

function normalizeOrigin(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    return new URL(withProtocol).origin
  } catch {
    return trimmed
  }
}

function buildAllowedOrigins(): string[] {
  const fromEnv = (process.env.FRONTEND_URL ?? 'http://localhost:5173')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean)
  return [...new Set([
    ...fromEnv,
    normalizeOrigin('http://localhost:5173'),
    normalizeOrigin('http://localhost:3000'),
    normalizeOrigin('http://localhost:3001'),
  ])]
}

function isVercelPreviewOrigin(origin: string, allowed: string): boolean {
  try {
    const allowedHost = new URL(allowed).hostname
    if (!allowedHost.endsWith('.vercel.app')) return false
    const originHost = new URL(origin).hostname
    if (!originHost.endsWith('.vercel.app')) return false
    const project = allowedHost.replace(/\.vercel\.app$/, '')
    return originHost === allowedHost || originHost.startsWith(`${project}-`)
  } catch {
    return false
  }
}

function isVercelAppOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin)
    return protocol === 'https:' && hostname.endsWith('.vercel.app')
  } catch {
    return false
  }
}

function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  const normalized = normalizeOrigin(origin)
  if (allowedOrigins.includes(normalized)) return true
  if (process.env.NODE_ENV !== 'production' && /^http:\/\/localhost:\d+$/.test(normalized)) {
    return true
  }
  if (allowedOrigins.some(allowed => isVercelPreviewOrigin(normalized, allowed))) return true
  // Frontend is hosted on Vercel — allow production + preview URLs
  if (isVercelAppOrigin(normalized)) return true
  return false
}

const allowedOrigins = buildAllowedOrigins()

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true)
    if (isOriginAllowed(origin, allowedOrigins)) return callback(null, true)
    console.warn(`CORS blocked origin: ${origin} (allowed: ${allowedOrigins.join(', ')})`)
    callback(null, false)
  },
  credentials: true,
}))
app.use(express.json({ limit: '15mb' }))

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'loyalgenie-backend' })
})

app.use('/api/onboarding', onboardingRoutes)
app.use('/api/auth', authRoutes)
app.use('/api/business', businessRoutes)

async function start() {
  await migrate()
  app.listen(PORT, () => {
    console.log(`LoyalGenie API running on http://localhost:${PORT}`)
    console.log(`CORS allowed origins: ${allowedOrigins.join(', ')} (+ localhost:* in dev)`)
  })
}

start().catch(err => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
