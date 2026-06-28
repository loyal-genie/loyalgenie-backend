import { PutObjectCommand, S3Client, ListObjectsV2Command, DeleteObjectsCommand, PutBucketCorsCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { nanoid } from 'nanoid'

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

let client: S3Client | null = null

function getR2Client(): S3Client {
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${requireEnv('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
        secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
      },
    })
  }
  return client
}

export function getR2PublicBaseUrl(): string {
  return requireEnv('R2_PUBLIC_URL').replace(/\/$/, '')
}

export function publicUrlForR2Key(key: string): string {
  return `${getR2PublicBaseUrl()}/${key.replace(/^\//, '')}`
}

export function extensionForContentType(contentType: string): string {
  if (contentType.includes('png')) return 'png'
  if (contentType.includes('webp')) return 'webp'
  if (contentType.includes('gif')) return 'gif'
  return 'jpg'
}

export function parseDataUrl(dataUrl: string | null | undefined): {
  buffer: Buffer
  contentType: string
  ext: string
} | null {
  if (!dataUrl || typeof dataUrl !== 'string') return null
  const trimmed = dataUrl.trim()
  if (!trimmed.startsWith('data:')) return null

  const match = trimmed.match(/^data:([^;]+);base64,(.+)$/s)
  if (!match) return null

  const contentType = match[1]
  const buffer = Buffer.from(match[2], 'base64')
  if (buffer.length < 64) return null

  return {
    buffer,
    contentType,
    ext: extensionForContentType(contentType),
  }
}

export async function uploadBufferToR2(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  await getR2Client().send(
    new PutObjectCommand({
      Bucket: requireEnv('R2_BUCKET_NAME'),
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  )
  return publicUrlForR2Key(key)
}

export async function uploadDataUrlToR2(
  keyWithoutExt: string,
  dataUrl: string | null | undefined,
): Promise<string | null> {
  const parsed = parseDataUrl(dataUrl)
  if (!parsed) return null
  const key = keyWithoutExt.includes('.')
    ? keyWithoutExt
    : `${keyWithoutExt}.${parsed.ext}`
  return uploadBufferToR2(key, parsed.buffer, parsed.contentType)
}

export type UploadPurpose = 'logo' | 'cover' | 'interior' | 'exterior'

export function buildUploadKey(
  businessId: string,
  purpose: UploadPurpose,
  contentType: string,
  index?: number,
): string {
  const ext = extensionForContentType(contentType)
  if (purpose === 'logo') return `businesses/${businessId}/logo.${ext}`
  if (purpose === 'cover') return `businesses/${businessId}/cover.${ext}`
  if (purpose === 'interior') return `businesses/${businessId}/interior/${index ?? 0}.${ext}`
  return `businesses/${businessId}/exterior/${index ?? 0}.${ext}`
}

export async function createPresignedUploadUrl(input: {
  key: string
  contentType: string
  expiresInSeconds?: number
}): Promise<{ uploadUrl: string; publicUrl: string; key: string }> {
  const command = new PutObjectCommand({
    Bucket: requireEnv('R2_BUCKET_NAME'),
    Key: input.key,
    ContentType: input.contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  })
  const uploadUrl = await getSignedUrl(getR2Client(), command, {
    expiresIn: input.expiresInSeconds ?? 600,
  })
  return {
    uploadUrl,
    publicUrl: publicUrlForR2Key(input.key),
    key: input.key,
  }
}

/** Presign for onboarding before a business row exists. */
export function buildTempUploadKey(
  purpose: UploadPurpose,
  contentType: string,
  index?: number,
): string {
  const token = nanoid(12)
  const ext = extensionForContentType(contentType)
  if (purpose === 'logo') return `uploads/temp/${token}/logo.${ext}`
  if (purpose === 'cover') return `uploads/temp/${token}/cover.${ext}`
  if (purpose === 'interior') return `uploads/temp/${token}/interior/${index ?? 0}.${ext}`
  return `uploads/temp/${token}/exterior/${index ?? 0}.${ext}`
}

/** Apply browser CORS rules so presigned PUT uploads work from the frontend. */
export async function configureR2BucketCors(origins: string[]): Promise<void> {
  const uniqueOrigins = [...new Set(origins.filter(Boolean))]
  await getR2Client().send(
    new PutBucketCorsCommand({
      Bucket: requireEnv('R2_BUCKET_NAME'),
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: uniqueOrigins,
            AllowedMethods: ['GET', 'PUT', 'HEAD'],
            AllowedHeaders: ['*'],
            ExposeHeaders: ['ETag'],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    }),
  )
}

export async function listAllR2Keys(prefix?: string): Promise<string[]> {
  const keys: string[] = []
  let continuationToken: string | undefined
  do {
    const page = await getR2Client().send(
      new ListObjectsV2Command({
        Bucket: requireEnv('R2_BUCKET_NAME'),
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    )
    for (const item of page.Contents ?? []) {
      if (item.Key) keys.push(item.Key)
    }
    continuationToken = page.NextContinuationToken
  } while (continuationToken)
  return keys
}

export async function deleteR2Keys(keys: string[]): Promise<number> {
  if (keys.length === 0) return 0
  const bucket = requireEnv('R2_BUCKET_NAME')
  let deleted = 0
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000).map(Key => ({ Key }))
    const result = await getR2Client().send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: batch, Quiet: true },
      }),
    )
    deleted += result.Deleted?.length ?? batch.length
  }
  return deleted
}
