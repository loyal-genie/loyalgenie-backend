import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { migrate } from './db/migrate.js'
import { getMsg91SetupStatus } from './services/msg91.js'
import onboardingRoutes from './routes/onboarding.js'
import authRoutes from './routes/auth.js'
import businessRoutes from './routes/business.js'
import campaignRoutes from './routes/campaigns.js'
import customerRoutes from './routes/customer.js'
import { normalizeFrontendOrigin, parseFrontendOrigins } from './utils/frontend-url.js'

dotenv.config()

const app = express()
const PORT = Number(process.env.PORT ?? 4000)

function normalizeOrigin(raw: string): string {
  return normalizeFrontendOrigin(raw)
}

function buildAllowedOrigins(): string[] {
  const fromEnv = parseFrontendOrigins()

  const expanded = [...fromEnv]
  for (const origin of fromEnv) {
    try {
      const { protocol, hostname } = new URL(origin)
      if (hostname.startsWith('www.')) {
        expanded.push(`${protocol}//${hostname.slice(4)}`)
      } else if (!hostname.includes('localhost') && hostname.includes('.')) {
        expanded.push(`${protocol}//www.${hostname}`)
      }
    } catch {
      /* ignore invalid URL */
    }
  }

  return [...new Set([
    ...expanded,
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

function isLoyalGenieOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin)
    if (protocol !== 'https:') return false
    return hostname === 'loyalgenie.in' || hostname === 'www.loyalgenie.in'
  } catch {
    return false
  }
}

function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  const normalized = normalizeOrigin(origin)
  if (allowedOrigins.includes(normalized)) return true
  if (isLoyalGenieOrigin(normalized)) return true
  if (process.env.NODE_ENV !== 'production' && /^http:\/\/localhost:\d+$/.test(normalized)) {
    return true
  }
  if (allowedOrigins.some(allowed => isVercelPreviewOrigin(normalized, allowed))) return true
  if (isVercelAppOrigin(normalized)) return true
  return false
}

const allowedOrigins = buildAllowedOrigins()

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true)
    if (isOriginAllowed(origin, allowedOrigins)) {
      // Must echo the request origin (not `true`) when credentials: true
      return callback(null, origin)
    }
    console.warn(`CORS blocked origin: ${origin} (allowed: ${allowedOrigins.join(', ')})`)
    callback(null, false)
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))
app.use(express.json({ limit: '15mb' }))

app.get('/api/health', (_req, res) => {
  const msg91 = getMsg91SetupStatus()
  res.json({
    status: 'ok',
    service: 'loyalgenie-backend',
    msg91,
    corsOrigins: allowedOrigins,
  })
})

app.use('/api/onboarding', onboardingRoutes)
app.use('/api/auth', authRoutes)
app.use('/api/business', businessRoutes)
app.use('/api/campaigns', campaignRoutes)
app.use('/api/customer', customerRoutes)

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
