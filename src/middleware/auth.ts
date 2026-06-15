import type { Request, Response, NextFunction } from 'express'
import { verifyToken, type AuthUser } from '../services/auth.js'

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser
    }
  }
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  return header.slice(7)
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractBearerToken(req)
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  const user = verifyToken(token, 'business')
  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
  req.user = user
  next()
}

export function requireCustomerAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractBearerToken(req)
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  const user = verifyToken(token, 'customer')
  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
  req.user = user
  next()
}
