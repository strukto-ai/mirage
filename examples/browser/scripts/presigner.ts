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
 * Server-side URL presigner used by the browser demo. Lives in Node (the vite
 * dev server process) and signs real URLs for AWS S3, Cloudflare R2, Google
 * Cloud Storage, and Oracle Cloud S3-compat storage using @aws-sdk — none of
 * the credentials ever touch the browser.
 *
 * Each backend is optional: if its env vars are missing, the corresponding
 * `/presign/<backend>` endpoint 404s and the browser demo skips that mount.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type ListObjectsV2CommandInput,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

// R2 intentionally excluded from the demo until its bucket-level CORS is
// configured via the Cloudflare dashboard. See docs/typescript/setup/r2.mdx
// for the setup steps; to re-enable, add 'r2' to BackendName and to the
// configured[] list in handlePresign.
export type BackendName = 's3' | 'gcs' | 'oci'
type Op = 'GET' | 'PUT' | 'HEAD' | 'DELETE' | 'LIST' | 'COPY'

interface BackendSigner {
  bucket: string
  client: S3Client
}

interface SignRequest {
  path: string
  op: Op
  opts?: {
    contentType?: string
    ttlSec?: number
    listPrefix?: string
    listDelimiter?: string
    listContinuationToken?: string
    copySource?: string
  }
}

function readEnv(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n]
    if (v !== undefined && v !== '') return v
  }
  return undefined
}

function maybeS3(): BackendSigner | null {
  const bucket = readEnv('AWS_S3_BUCKET')
  const accessKeyId = readEnv('AWS_ACCESS_KEY_ID')
  const secretAccessKey = readEnv('AWS_SECRET_ACCESS_KEY')
  if (bucket === undefined || accessKeyId === undefined || secretAccessKey === undefined) {
    return null
  }
  return {
    bucket,
    client: new S3Client({
      region: readEnv('AWS_DEFAULT_REGION') ?? 'us-east-1',
      credentials: { accessKeyId, secretAccessKey },
    }),
  }
}

function maybeGcs(): BackendSigner | null {
  const bucket = readEnv('GCS_BUCKET')
  const accessKeyId = readEnv('GCS_ACCESS_KEY_ID')
  const secretAccessKey = readEnv('GCS_SECRET_ACCESS_KEY')
  if (bucket === undefined || accessKeyId === undefined || secretAccessKey === undefined) {
    return null
  }
  return {
    bucket,
    client: new S3Client({
      region: readEnv('GCS_REGION') ?? 'auto',
      endpoint: readEnv('GCS_ENDPOINT_URL') ?? 'https://storage.googleapis.com',
      credentials: { accessKeyId, secretAccessKey },
    }),
  }
}

function maybeOci(): BackendSigner | null {
  const bucket = readEnv('OCI_BUCKET')
  const namespace = readEnv('OCI_NAMESPACE')
  const region = readEnv('OCI_REGION')
  const accessKeyId = readEnv('OCI_ACCESS_KEY_ID')
  const secretAccessKey = readEnv('OCI_SECRET_ACCESS_KEY')
  if (
    bucket === undefined ||
    namespace === undefined ||
    region === undefined ||
    accessKeyId === undefined ||
    secretAccessKey === undefined
  ) {
    return null
  }
  return {
    bucket,
    client: new S3Client({
      region,
      endpoint:
        readEnv('OCI_ENDPOINT_URL') ??
        `https://${namespace}.compat.objectstorage.${region}.oci.customer-oci.com`,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    }),
  }
}

const signers: Partial<Record<BackendName, BackendSigner>> = {}

function ensureSigner(name: BackendName): BackendSigner | null {
  if (signers[name] !== undefined) return signers[name]
  const s = name === 's3' ? maybeS3() : name === 'gcs' ? maybeGcs() : maybeOci()
  if (s === null) return null
  signers[name] = s
  return s
}

async function signOne(signer: BackendSigner, req: SignRequest): Promise<string> {
  const key = req.path.replace(/^\/+/, '')
  const ttl = req.opts?.ttlSec ?? 300
  const bucket = signer.bucket
  switch (req.op) {
    case 'GET':
      return getSignedUrl(signer.client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: ttl,
      })
    case 'PUT':
      return getSignedUrl(
        signer.client,
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          ...(req.opts?.contentType !== undefined ? { ContentType: req.opts.contentType } : {}),
        }),
        { expiresIn: ttl },
      )
    case 'HEAD':
      return getSignedUrl(signer.client, new HeadObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: ttl,
      })
    case 'DELETE':
      return getSignedUrl(signer.client, new DeleteObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: ttl,
      })
    case 'LIST': {
      const input: ListObjectsV2CommandInput = { Bucket: bucket }
      if (req.opts?.listPrefix !== undefined && req.opts.listPrefix !== '') {
        input.Prefix = req.opts.listPrefix
      }
      if (req.opts?.listDelimiter !== undefined) input.Delimiter = req.opts.listDelimiter
      if (req.opts?.listContinuationToken !== undefined) {
        input.ContinuationToken = req.opts.listContinuationToken
      }
      return getSignedUrl(signer.client, new ListObjectsV2Command(input), { expiresIn: ttl })
    }
    case 'COPY': {
      if (req.opts?.copySource === undefined) {
        throw new Error('COPY signing requires opts.copySource')
      }
      return getSignedUrl(
        signer.client,
        new CopyObjectCommand({
          Bucket: bucket,
          Key: key,
          CopySource: `${bucket}/${req.opts.copySource}`,
        }),
        { expiresIn: ttl, signableHeaders: new Set(['x-amz-copy-source']) },
      )
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf-8')
    })
    req.on('end', () => {
      resolve(data)
    })
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(payload))
}

/**
 * Handle one HTTP request for the presigner. Returns `true` if the middleware
 * consumed the request; `false` to let vite handle it.
 */
export async function handlePresign(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url ?? ''
  if (!url.startsWith('/presign/')) return false
  const pathOnly = url.split('?')[0] ?? url
  if (pathOnly === '/presign/status') {
    const configured = (['s3', 'gcs', 'oci'] as const).filter((n) => ensureSigner(n) !== null)
    json(res, 200, { configured })
    return true
  }
  const match = /^\/presign\/(s3|gcs|oci)$/.exec(pathOnly)
  if (match === null) return false
  const backend = match[1] as BackendName
  if (req.method !== 'POST') {
    json(res, 405, { error: 'method not allowed' })
    return true
  }
  const signer = ensureSigner(backend)
  if (signer === null) {
    json(res, 404, { error: `${backend} not configured` })
    return true
  }
  try {
    const body = await readBody(req)
    const parsed = JSON.parse(body) as SignRequest
    const signedUrl = await signOne(signer, parsed)
    json(res, 200, { url: signedUrl })
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
  return true
}
