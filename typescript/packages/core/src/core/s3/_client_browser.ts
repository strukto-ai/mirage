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

import type { S3BrowserPresignedUrlProvider, S3Config } from '../../resource/s3/config.ts'
import type { S3Module, S3SendClient } from './_client.ts'

function decodeEntities(s: string): string {
  return s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

function tagText(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)
  const m = re.exec(xml)
  return m === null ? null : decodeEntities(m[1] ?? '')
}

function tagBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g')
  const blocks: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) blocks.push(m[1] ?? '')
  return blocks
}

interface ListV2Result {
  CommonPrefixes: { Prefix: string }[]
  Contents: { Key: string; Size: number; LastModified?: Date; ETag?: string }[]
  IsTruncated: boolean
  NextContinuationToken?: string
}

function parseListObjectsV2(xml: string): ListV2Result {
  const body = tagText(xml, 'ListBucketResult') ?? xml
  const truncated = (tagText(body, 'IsTruncated') ?? 'false').toLowerCase() === 'true'
  const nextToken = tagText(body, 'NextContinuationToken') ?? undefined
  const prefixes: { Prefix: string }[] = []
  for (const blk of tagBlocks(body, 'CommonPrefixes')) {
    const p = tagText(blk, 'Prefix')
    if (p !== null && p !== '') prefixes.push({ Prefix: p })
  }
  const contents: ListV2Result['Contents'] = []
  for (const blk of tagBlocks(body, 'Contents')) {
    const key = tagText(blk, 'Key')
    if (key === null) continue
    const sizeStr = tagText(blk, 'Size')
    const size = sizeStr !== null ? Number.parseInt(sizeStr, 10) : 0
    const lastMod = tagText(blk, 'LastModified')
    const etagRaw = tagText(blk, 'ETag')
    const etag = etagRaw !== null ? etagRaw.replaceAll('"', '') : ''
    const entry: ListV2Result['Contents'][number] = {
      Key: key,
      Size: Number.isFinite(size) ? size : 0,
    }
    if (lastMod !== null) entry.LastModified = new Date(lastMod)
    if (etag !== '') entry.ETag = etag
    contents.push(entry)
  }
  const out: ListV2Result = {
    CommonPrefixes: prefixes,
    Contents: contents,
    IsTruncated: truncated,
  }
  if (nextToken !== undefined) out.NextContinuationToken = nextToken
  return out
}

type BrowserCmdTag = 'Get' | 'Head' | 'List' | 'Put' | 'Delete' | 'Copy'

class BrowserCommand<T extends BrowserCmdTag, I extends Record<string, unknown>> {
  readonly __mirageTag: T
  readonly input: I
  constructor(tag: T, input: I) {
    this.__mirageTag = tag
    this.input = input
  }
}

class GetObjectCommand extends BrowserCommand<'Get', Record<string, unknown>> {
  constructor(input: Record<string, unknown>) {
    super('Get', input)
  }
}
class HeadObjectCommand extends BrowserCommand<'Head', Record<string, unknown>> {
  constructor(input: Record<string, unknown>) {
    super('Head', input)
  }
}
class ListObjectsV2Command extends BrowserCommand<'List', Record<string, unknown>> {
  constructor(input: Record<string, unknown>) {
    super('List', input)
  }
}
class PutObjectCommand extends BrowserCommand<'Put', Record<string, unknown>> {
  constructor(input: Record<string, unknown>) {
    super('Put', input)
  }
}
class DeleteObjectCommand extends BrowserCommand<'Delete', Record<string, unknown>> {
  constructor(input: Record<string, unknown>) {
    super('Delete', input)
  }
}
class DeleteObjectsCommand extends BrowserCommand<
  'Delete',
  { Bucket: string; Delete: { Objects: { Key: string }[] } }
> {
  constructor(input: { Bucket: string; Delete: { Objects: { Key: string }[] } }) {
    super('Delete', input)
  }
}
class CopyObjectCommand extends BrowserCommand<'Copy', Record<string, unknown>> {
  constructor(input: Record<string, unknown>) {
    super('Copy', input)
  }
}

const stubS3ClientCtor = function stubS3Client(): never {
  throw new Error(
    'BROWSER_S3_MODULE.S3Client is a stub — use createS3Client(config) to get the presigned-fetch client',
  )
} as unknown as S3Module['S3Client']

export const BROWSER_S3_MODULE: S3Module = {
  S3Client: stubS3ClientCtor,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CopyObjectCommand,
} as S3Module

async function bodyFromResponse(resp: Response): Promise<AsyncIterable<Uint8Array>> {
  const stream = resp.body
  if (stream === null) {
    const buf = new Uint8Array(await resp.arrayBuffer())
    return (async function* () {
      await Promise.resolve()
      yield buf
    })()
  }
  const reader = stream.getReader()
  return (async function* () {
    let drained = false
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) {
          drained = true
          return
        }
        yield value
      }
    } finally {
      // A consumer that stops early — a ranged read served by streaming — wants
      // the transfer to stop with it. Releasing the lock alone leaves the body
      // downloading, so the bytes it went out of its way not to ask for arrive
      // anyway; cancel() is what actually aborts it.
      if (!drained) await reader.cancel()
      reader.releaseLock()
    }
  })()
}

function keyFromInput(input: Record<string, unknown>): string {
  const k = input.Key
  return typeof k === 'string' ? k : ''
}

function makeNotFound(path: string): Error & { $metadata: { httpStatusCode: number } } {
  const e = new Error(`S3 object not found: ${path}`) as Error & {
    $metadata: { httpStatusCode: number }
  }
  e.$metadata = { httpStatusCode: 404 }
  return e
}

async function sendBrowserCommand(
  provider: S3BrowserPresignedUrlProvider,
  defaultContentType: string | undefined,
  cmd: unknown,
): Promise<Record<string, unknown>> {
  const browserCmd = cmd as BrowserCommand<BrowserCmdTag, Record<string, unknown>>
  if (typeof browserCmd.__mirageTag !== 'string') {
    throw new Error(
      'presigned-fetch client received a non-browser S3 command; check that you ' +
        'did not mix AWS SDK command classes with a presigner-backed config',
    )
  }
  const tag = browserCmd.__mirageTag
  switch (tag) {
    case 'Get': {
      const input = browserCmd.input as { Key?: unknown; Range?: unknown }
      const key = typeof input.Key === 'string' ? input.Key : ''
      // A presigned GET carries no Range: the header would make the request
      // non-simple and trip a CORS preflight presigned deployments generally
      // do not allow. Serving it anyway would return the whole object as if it
      // were the requested window, so refuse instead of answering wrongly —
      // core/s3/stream.ts streams the window on this path.
      if (input.Range !== undefined) {
        throw new Error(
          `S3 GET ${key}: the presigned-fetch client cannot serve a ranged ` +
            'read; use core/s3/stream.ts readRange, which streams the window',
        )
      }
      const url = await provider(`/${key}`, 'GET')
      const resp = await fetch(url)
      if (resp.status === 404) throw makeNotFound(key)
      if (!resp.ok) {
        throw new Error(`S3 GET ${key} failed: ${String(resp.status)} ${resp.statusText}`)
      }
      const body = await bodyFromResponse(resp)
      const lenHeader = resp.headers.get('content-length')
      const ContentLength = lenHeader !== null ? Number.parseInt(lenHeader, 10) : undefined
      const out: Record<string, unknown> = { Body: body }
      if (ContentLength !== undefined && !Number.isNaN(ContentLength)) {
        out.ContentLength = ContentLength
      }
      const etag = resp.headers.get('etag')?.replace(/^"|"$/g, '') ?? ''
      if (etag !== '') out.ETag = etag
      const lm = resp.headers.get('last-modified')
      if (lm !== null) out.LastModified = new Date(lm)
      return out
    }
    case 'Head': {
      const key = keyFromInput(browserCmd.input)
      const url = await provider(`/${key}`, 'HEAD')
      const resp = await fetch(url, { method: 'HEAD' })
      if (resp.status === 404) throw makeNotFound(key)
      if (!resp.ok) {
        throw new Error(`S3 HEAD ${key} failed: ${String(resp.status)} ${resp.statusText}`)
      }
      const lenHeader = resp.headers.get('content-length')
      const ContentLength = lenHeader !== null ? Number.parseInt(lenHeader, 10) : undefined
      const etag = resp.headers.get('etag')?.replace(/^"|"$/g, '') ?? ''
      const lm = resp.headers.get('last-modified')
      const out: Record<string, unknown> = {}
      if (ContentLength !== undefined && !Number.isNaN(ContentLength)) {
        out.ContentLength = ContentLength
      }
      if (etag !== '') out.ETag = etag
      if (lm !== null) out.LastModified = new Date(lm)
      return out
    }
    case 'List': {
      const input = browserCmd.input as {
        Prefix?: string
        Delimiter?: string
        ContinuationToken?: string
      }
      const opts: {
        listPrefix: string
        listDelimiter?: string
        listContinuationToken?: string
      } = {
        listPrefix: input.Prefix ?? '',
      }
      if (input.Delimiter !== undefined) opts.listDelimiter = input.Delimiter
      if (input.ContinuationToken !== undefined)
        opts.listContinuationToken = input.ContinuationToken
      const url = await provider('/', 'LIST', opts)
      const resp = await fetch(url)
      if (!resp.ok) {
        throw new Error(`S3 LIST failed: ${String(resp.status)} ${resp.statusText}`)
      }
      const xml = await resp.text()
      return parseListObjectsV2(xml) as unknown as Record<string, unknown>
    }
    case 'Put': {
      const input = browserCmd.input as { Key?: unknown; Body?: unknown; ContentType?: unknown }
      const key = typeof input.Key === 'string' ? input.Key : ''
      const contentType =
        typeof input.ContentType === 'string'
          ? input.ContentType
          : (defaultContentType ?? 'application/octet-stream')
      const url = await provider(`/${key}`, 'PUT', { contentType })
      const body = input.Body as Uint8Array | string | undefined
      const resp = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: body as BodyInit,
      })
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '')
        throw new Error(
          `S3 PUT ${key} failed: ${String(resp.status)} ${resp.statusText}${
            errBody !== '' ? ` — ${errBody.slice(0, 200)}` : ''
          }`,
        )
      }
      return {}
    }
    case 'Delete': {
      const input = browserCmd.input as {
        Key?: unknown
        Delete?: { Objects?: { Key: string }[] }
      }
      if (typeof input.Key === 'string') {
        const url = await provider(`/${input.Key}`, 'DELETE')
        const resp = await fetch(url, { method: 'DELETE' })
        if (resp.status !== 404 && !resp.ok) {
          throw new Error(
            `S3 DELETE ${input.Key} failed: ${String(resp.status)} ${resp.statusText}`,
          )
        }
        return {}
      }
      const objects = input.Delete?.Objects ?? []
      await Promise.all(
        objects.map(async (o) => {
          const url = await provider(`/${o.Key}`, 'DELETE')
          await fetch(url, { method: 'DELETE' })
        }),
      )
      return { Deleted: objects.map((o) => ({ Key: o.Key })) }
    }
    case 'Copy': {
      const input = browserCmd.input as { Key?: unknown; CopySource?: unknown }
      const dstKey = typeof input.Key === 'string' ? input.Key : ''
      const copySrcRaw = typeof input.CopySource === 'string' ? input.CopySource : ''
      const srcKey = copySrcRaw.replace(/^\/?[^/]+\//, '')
      const url = await provider(`/${dstKey}`, 'COPY', { copySource: srcKey })
      const resp = await fetch(url, {
        method: 'PUT',
        headers: { 'x-amz-copy-source': `/${srcKey}` },
      })
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '')
        throw new Error(
          `S3 COPY ${copySrcRaw} → ${dstKey} failed: ${String(resp.status)} ${resp.statusText}${
            errBody !== '' ? ` — ${errBody.slice(0, 200)}` : ''
          }`,
        )
      }
      return {}
    }
  }
}

export function createBrowserS3Client(config: S3Config): S3SendClient {
  const provider = config.presignedUrlProvider
  if (provider === undefined) {
    throw new Error('createBrowserS3Client called without presignedUrlProvider')
  }
  return {
    send: (cmd) => sendBrowserCommand(provider, config.defaultContentType, cmd),
  }
}
