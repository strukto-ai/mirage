// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

/**
 * One-shot: configure CORS on every cloud bucket the presigner has creds for.
 * Reads env from repo-root .env.development (same source the vite presigner
 * middleware uses). Run with `npx tsx scripts/configure-cors.ts`.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PutBucketCorsCommand, S3Client } from '@aws-sdk/client-s3'
import dotenv from 'dotenv'

const here = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(here, '../../../.env.development') })

const ORIGINS =
  process.argv.length > 2
    ? process.argv.slice(2)
    : ['http://localhost:5173', 'http://localhost:5174']

const CORS_RULES = [
  {
    AllowedOrigins: ORIGINS,
    AllowedMethods: ['GET', 'PUT', 'HEAD', 'DELETE', 'POST'],
    AllowedHeaders: ['*'],
    ExposeHeaders: ['ETag', 'Content-Length', 'Content-Type', 'Last-Modified'],
    MaxAgeSeconds: 3000,
  },
]

type Target = {
  name: string
  bucket: string
  client: S3Client
  note?: string
}

function readEnv(...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = process.env[k]
    if (v !== undefined && v !== '') return v
  }
  return undefined
}

function targets(): Target[] {
  const out: Target[] = []

  const s3Bucket = readEnv('AWS_S3_BUCKET')
  const s3AccessKey = readEnv('AWS_ACCESS_KEY_ID')
  const s3Secret = readEnv('AWS_SECRET_ACCESS_KEY')
  if (s3Bucket !== undefined && s3AccessKey !== undefined && s3Secret !== undefined) {
    out.push({
      name: 'S3',
      bucket: s3Bucket,
      client: new S3Client({
        region: readEnv('AWS_DEFAULT_REGION') ?? 'us-east-1',
        credentials: { accessKeyId: s3AccessKey, secretAccessKey: s3Secret },
      }),
    })
  }

  const r2Bucket = readEnv('R2_BUCKET')
  const r2AccessKey = readEnv('R2_ACCESS_KEY_ID')
  const r2Secret = readEnv('R2_SECRET_ACCESS_KEY')
  const r2Account = readEnv('R2_ACCOUNT_ID')
  const r2Endpoint = readEnv('R2_ENDPOINT_URL')
  if (
    r2Bucket !== undefined &&
    r2AccessKey !== undefined &&
    r2Secret !== undefined &&
    (r2Account !== undefined || r2Endpoint !== undefined)
  ) {
    out.push({
      name: 'R2',
      bucket: r2Bucket,
      client: new S3Client({
        region: readEnv('R2_REGION') ?? 'auto',
        endpoint: r2Endpoint ?? `https://${r2Account!}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: r2AccessKey, secretAccessKey: r2Secret },
      }),
    })
  }

  const gcsBucket = readEnv('GCS_BUCKET')
  const gcsAccessKey = readEnv('GCS_ACCESS_KEY_ID')
  const gcsSecret = readEnv('GCS_SECRET_ACCESS_KEY')
  if (gcsBucket !== undefined && gcsAccessKey !== undefined && gcsSecret !== undefined) {
    out.push({
      name: 'GCS',
      bucket: gcsBucket,
      client: new S3Client({
        region: readEnv('GCS_REGION') ?? 'auto',
        endpoint: readEnv('GCS_ENDPOINT_URL') ?? 'https://storage.googleapis.com',
        credentials: { accessKeyId: gcsAccessKey, secretAccessKey: gcsSecret },
      }),
      note: 'GCS S3-compat rejects PutBucketCors — use `gsutil cors set` if this fails.',
    })
  }

  return out
}

async function applyCors(target: Target): Promise<void> {
  const cmd = new PutBucketCorsCommand({
    Bucket: target.bucket,
    CORSConfiguration: { CORSRules: CORS_RULES },
  })
  try {
    await target.client.send(cmd)
    console.log(`  ✓ ${target.name} (${target.bucket}) — CORS applied for ${ORIGINS.join(', ')}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`  ✗ ${target.name} (${target.bucket}) — ${msg}`)
    if (target.note !== undefined) console.log(`    ${target.note}`)
  } finally {
    target.client.destroy()
  }
}

async function main(): Promise<void> {
  const ts = targets()
  if (ts.length === 0) {
    console.error('No cloud credentials found in .env.development')
    process.exit(1)
  }
  console.log(`Applying CORS (origins ${ORIGINS.join(', ')}) to ${String(ts.length)} bucket(s):`)
  for (const t of ts) await applyCors(t)
  console.log('\nDone. Reload the browser demo — shell commands should now succeed.')
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
