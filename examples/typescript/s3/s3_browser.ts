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
 * Browser S3 example — mirrors examples/python/s3/s3.py but uses
 * @struktoai/mirage-browser (fetch + presigned URLs, no AWS SDK at runtime).
 *
 * Architecture:
 *   - "Backend signer" (top of file) runs in Node with AWS creds, signs
 *     per-path presigned URLs on demand. In production this is your
 *     Express/Hono/Lambda endpoint.
 *   - "Browser code" (bottom) uses @struktoai/mirage-browser with nothing but
 *     fetch. That's exactly what you'd ship to production browsers.
 *
 * Limitations vs Node S3:
 *   - No ls/tree/find/glob (presigner doesn't sign list endpoints yet).
 *   - Operations on known paths (cat, grep, head, wc, jq, stat on a file)
 *     all work.
 */
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
import {
  MountMode,
  PathSpec,
  S3VFS,
  type S3BrowserOperation,
  type S3BrowserSignOptions,
  Workspace,
} from '@struktoai/mirage-browser'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (v === undefined || v === '') throw new Error(`missing env: ${name}`)
  return v
}

// ── MOCK BACKEND ────────────────────────────────────────────────
const BUCKET = requireEnv('AWS_S3_BUCKET')
const signerClient = new S3Client({
  region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
  credentials: {
    accessKeyId: requireEnv('AWS_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('AWS_SECRET_ACCESS_KEY'),
  },
})

async function mockBackendSign(
  path: string,
  operation: S3BrowserOperation,
  options: S3BrowserSignOptions = {},
): Promise<string> {
  const key = path.replace(/^\/+/, '')
  const ttl = options.ttlSec ?? 300
  const input = { Bucket: BUCKET, Key: key }
  switch (operation) {
    case 'GET':
      return getSignedUrl(signerClient, new GetObjectCommand(input), {
        expiresIn: ttl,
      })
    case 'PUT': {
      const putInput = {
        ...input,
        ...(options.contentType !== undefined
          ? { ContentType: options.contentType }
          : {}),
      }
      return getSignedUrl(signerClient, new PutObjectCommand(putInput), {
        expiresIn: ttl,
      })
    }
    case 'HEAD':
      return getSignedUrl(signerClient, new HeadObjectCommand(input), {
        expiresIn: ttl,
      })
    case 'DELETE':
      return getSignedUrl(signerClient, new DeleteObjectCommand(input), {
        expiresIn: ttl,
      })
    case 'LIST': {
      const listInput: ListObjectsV2CommandInput = { Bucket: BUCKET }
      if (options.listPrefix !== undefined && options.listPrefix !== '') {
        listInput.Prefix = options.listPrefix
      }
      if (options.listDelimiter !== undefined) {
        listInput.Delimiter = options.listDelimiter
      }
      if (options.listContinuationToken !== undefined) {
        listInput.ContinuationToken = options.listContinuationToken
      }
      return getSignedUrl(signerClient, new ListObjectsV2Command(listInput), {
        expiresIn: ttl,
      })
    }
    case 'COPY': {
      if (options.copySource === undefined) {
        throw new Error('COPY signing requires options.copySource')
      }
      return getSignedUrl(
        signerClient,
        new CopyObjectCommand({
          Bucket: BUCKET,
          Key: key,
          CopySource: `${BUCKET}/${options.copySource}`,
        }),
        { expiresIn: ttl, signableHeaders: new Set(['x-amz-copy-source']) },
      )
    }
  }
}

// ── "BROWSER" CODE ──────────────────────────────────────────────
const s3 = new S3VFS({
  bucket: BUCKET,
  presignedUrlProvider: mockBackendSign,
})

const ws = new Workspace({ '/s3/': s3 }, { mode: MountMode.WRITE })

const decoder = new TextDecoder()

async function runOut(cmd: string): Promise<string> {
  const result = await ws.shell(cmd)
  return decoder.decode(result.stdout).trim()
}

async function run(cmd: string, label?: string): Promise<void> {
  console.log(`\n--- ${label ?? cmd} ---`)
  const result = await ws.shell(cmd)
  const out = decoder.decode(result.stdout).trim()
  const err = decoder.decode(result.stderr).trim()
  if (out !== '') {
    const lines = out.split('\n')
    if (lines.length > 5) {
      for (const line of lines.slice(0, 4)) console.log(`  ${line.slice(0, 100)}`)
      console.log(`  … (${String(lines.length - 4)} more lines)`)
    } else {
      for (const line of lines) console.log(`  ${line.slice(0, 120)}`)
    }
  }
  if (err !== '') console.log(`  stderr: ${err}`)
  console.log(`  exit=${String(result.exitCode)}`)
}

async function main(): Promise<void> {
  console.log('=== SINGLE FILE OPERATIONS ===')

  await run('stat /s3/data/example.jsonl')
  await run('wc -l /s3/data/example.jsonl')
  await run('head -n 2 /s3/data/example.jsonl')

  console.log('\n=== GREP PIPELINES ===')
  await run('grep mirage /s3/data/example.jsonl | head -n 3')
  await run('grep -m 1 mirage /s3/data/example.jsonl | wc -c')
  await run('grep mirage /s3/data/example.jsonl | wc -l')

  console.log('\n=== CONTROL FLOW ===')
  await run('grep -m 1 mirage /s3/data/example.jsonl && echo found')
  await run('grep NONEXISTENT /s3/data/example.jsonl || echo not_found')

  console.log('\n=== MULTI-STAGE PIPE (cat → grep → sort → uniq) ===')
  await run(
    'cat /s3/data/example.jsonl | grep queue-operation | sort | uniq | wc -l',
  )

  console.log('\n=== LAZY PIPE: head stops early, upstream aborts ===')
  await run(
    'grep queue-operation /s3/data/example.jsonl | grep -v error | head -n 2',
  )

  console.log('\n=== JQ QUERIES ===')
  await run('jq .metadata.version /s3/data/example.json')
  await run('jq ".departments[].teams[].name" /s3/data/example.json')
  await run('jq .metadata.total_budget /s3/data/example.json')

  console.log('\n=== WRITE + READ BACK ===')
  const testKey = `data/browser-demo/${String(Date.now())}.txt`
  await run(`echo "hello from browser S3" > /s3/${testKey}`, 'write')
  await run(`cat /s3/${testKey}`, 'read back')
  await run(`wc -c /s3/${testKey}`, 'size')

  console.log('\n=== APPEND (read + concat + write) ===')
  await ws.shell(`echo "second line" >> /s3/${testKey}`)
  await run(`cat /s3/${testKey}`, 'after append')

  console.log('\n=== LISTING (now supported via LIST signer) ===')
  await run('ls /s3/data | head -n 5')
  await run('tree -L 1 /s3/data')
  await run('find /s3/data -name "*.json"')
  await run('du /s3/data/example.json')

  console.log('\n=== COPY (server-side via CopyObject) ===')
  const copyKey = `data/browser-demo/copy-${String(Date.now())}.txt`
  await run(`cp /s3/${testKey} /s3/${copyKey}`, 'cp')
  await run(`cat /s3/${copyKey}`, 'cat copy')
  await ws.shell(`rm /s3/${copyKey}`)

  console.log('\n=== CLEANUP ===')
  await ws.shell(`rm /s3/${testKey}`)
  // Verify via direct backend HEAD (bypass any workspace cache)
  try {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3')
    await signerClient.send(new HeadObjectCommand({ Bucket: BUCKET, Key: testKey }))
    console.log(`  ✗ ${testKey} still exists`)
  } catch (err) {
    const httpStatus = (err as { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode
    console.log(`  ✓ ${testKey} deleted (S3 HEAD returns ${String(httpStatus)})`)
  }

  signerClient.destroy()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
