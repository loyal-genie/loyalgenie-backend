import { db } from '../db/client.js'

export function slugifyCafeName(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return base || 'cafe'
}

export async function uniqueCafeSlug(name: string): Promise<string> {
  let base = slugifyCafeName(name)
  let candidate = base
  let n = 0

  while (await slugTaken(candidate)) {
    n += 1
    candidate = `${base}-${n}`
  }
  return candidate
}

async function slugTaken(slug: string): Promise<boolean> {
  const result = await db.execute({
    sql: 'SELECT id FROM businesses WHERE qr_slug = ? LIMIT 1',
    args: [slug],
  })
  return result.rows.length > 0
}
