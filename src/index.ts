import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { migrate } from './db/migrate.js'
import onboardingRoutes from './routes/onboarding.js'
import authRoutes from './routes/auth.js'

dotenv.config()

const app = express()
const PORT = Number(process.env.PORT ?? 4000)

function buildAllowedOrigins(): string[] {
  const fromEnv = (process.env.FRONTEND_URL ?? 'http://localhost:5173')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  return [...new Set([...fromEnv, 'http://localhost:5173', 'http://localhost:3000', 'http://localhost:3001'])]
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

function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  if (allowedOrigins.includes(origin)) return true
  if (process.env.NODE_ENV !== 'production' && /^http:\/\/localhost:\d+$/.test(origin)) {
    return true
  }
  return allowedOrigins.some(allowed => isVercelPreviewOrigin(origin, allowed))
}

const allowedOrigins = buildAllowedOrigins()

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true)
    if (isOriginAllowed(origin, allowedOrigins)) return callback(null, true)
    callback(new Error(`CORS blocked for origin: ${origin}`))
  },
  credentials: true,
}))
app.use(express.json({ limit: '15mb' }))

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'loyalgenie-backend' })
})

app.use('/api/onboarding', onboardingRoutes)
app.use('/api/auth', authRoutes)

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
