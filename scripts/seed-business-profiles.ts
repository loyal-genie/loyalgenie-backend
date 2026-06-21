/**
 * Backfill customer-facing business profile fields to match Figma demo data.
 * Run: npm run db:seed-profiles
 */
import { db } from '../src/db/client.js'
import { migrate } from '../src/db/migrate.js'

const DEMO_HERO = '/customer/demo/amber-cafe-hero.jpg'
const DEMO_HERO_2 = '/customer/demo/amber-cafe-hero-2.jpg'

type ProfilePatch = {
  name?: string
  tagline?: string
  business_type?: string
  landmark?: string
  city?: string
  mobile?: string
  operating_hours?: string
  google_review?: string
  rating?: number
  latitude?: number
  longitude?: number
  display_distance_km?: number
  mechanic_tags?: string
  cover_banner_data?: string
  interior_photos_data?: string
  branch_address?: string
}

const BY_NAME: Record<string, ProfilePatch> = {
  amber: {
    name: 'Amber Cafe',
    tagline: 'Slow roasts. Honeyed pastries. A regulars-only kind of warm.',
    business_type: 'Cafe',
    landmark: 'Indiranagar',
    city: 'Bangalore',
    mobile: '8045678901',
    operating_hours: 'Open until 10 PM',
    google_review: 'https://www.google.com/maps/search/?api=1&query=Amber+Cafe+Indiranagar+Bangalore',
    rating: 4.7,
    latitude: 12.9784,
    longitude: 77.6408,
    display_distance_km: 0.4,
    mechanic_tags: JSON.stringify(['stamp', 'spin', 'scratch', 'check-in-loyalty']),
    cover_banner_data: DEMO_HERO,
    interior_photos_data: JSON.stringify([DEMO_HERO_2, DEMO_HERO]),
    branch_address: 'Indiranagar',
  },
}

const DEFAULT_CAFE: ProfilePatch = {
  tagline: 'Your neighbourhood spot for rewards and good vibes.',
  business_type: 'Cafe',
  operating_hours: 'Open until 10 PM',
  rating: 4.5,
  display_distance_km: 0.8,
  google_review: 'https://www.google.com/maps',
  cover_banner_data: DEMO_HERO,
}

function matchProfile(name: string): ProfilePatch {
  const key = name.toLowerCase()
  for (const [needle, patch] of Object.entries(BY_NAME)) {
    if (key.includes(needle)) return patch
  }
  if (key.includes('cafe') || key.includes('coffee')) return DEFAULT_CAFE
  return {
    operating_hours: 'Open until 9 PM',
    rating: 4.3,
    display_distance_km: 1.2,
  }
}

async function main() {
  await migrate()

  const businesses = await db.execute('SELECT id, name, tagline, cover_banner_data, rating FROM businesses')
  let updated = 0

  for (const row of businesses.rows) {
    const name = row.name as string
    const patch = matchProfile(name)
    const sets: string[] = []
    const args: (string | number | null)[] = []

    const current = row as Record<string, unknown>

    const apply = (col: string, val: string | number | null | undefined, onlyIfEmpty?: keyof typeof current) => {
      if (val === undefined || val === null) return
      if (onlyIfEmpty && current[onlyIfEmpty]) return
      sets.push(`${col} = ?`)
      args.push(val)
    }

    if (patch.name) {
      sets.push('name = ?')
      args.push(patch.name)
    }

    if (patch.business_type) {
      sets.push('business_type = ?')
      args.push(patch.business_type)
    }

    apply('tagline', patch.tagline, 'tagline')
    apply('landmark', patch.landmark, 'landmark')
    apply('city', patch.city)
    apply('mobile', patch.mobile, 'mobile')
    apply('operating_hours', patch.operating_hours, 'operating_hours')
    apply('google_review', patch.google_review, 'google_review')
    apply('rating', patch.rating, 'rating')
    apply('latitude', patch.latitude, 'latitude')
    apply('longitude', patch.longitude, 'longitude')
    apply('display_distance_km', patch.display_distance_km)
    apply('mechanic_tags', patch.mechanic_tags)
    apply('cover_banner_data', patch.cover_banner_data, 'cover_banner_data')
    if (patch.interior_photos_data && !current.interior_photos_data) {
      sets.push('interior_photos_data = ?')
      args.push(patch.interior_photos_data)
    }

    if (sets.length === 0) continue

    args.push(row.id as string)
    await db.execute({
      sql: `UPDATE businesses SET ${sets.join(', ')} WHERE id = ?`,
      args,
    })

    if (patch.branch_address) {
      const branch = await db.execute({
        sql: 'SELECT id, address, city FROM branches WHERE business_id = ? AND is_primary = 1 LIMIT 1',
        args: [row.id as string],
      })
      const branchRow = branch.rows[0] as { id: string; address?: string; city?: string } | undefined
      if (branchRow) {
        const nextAddress = branchRow.address?.trim() ? branchRow.address : patch.branch_address
        const nextCity = branchRow.city?.trim() ? branchRow.city : (patch.city ?? 'Bangalore')
        await db.execute({
          sql: 'UPDATE branches SET address = ?, city = ? WHERE id = ?',
          args: [nextAddress, nextCity, branchRow.id],
        })
      }
    }

    updated++
    console.log(`Updated profile: ${name}`)
  }

  console.log(`\nDone. ${updated} business(es) updated.`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
