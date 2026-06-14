import { createClient } from '@libsql/client'
import dotenv from 'dotenv'

dotenv.config()

const url = process.env.DATABASE_URL
const authToken = process.env.DATABASE_AUTH_TOKEN

if (!url || !authToken) {
  throw new Error('DATABASE_URL and DATABASE_AUTH_TOKEN must be set in .env')
}

export const db = createClient({ url, authToken })
