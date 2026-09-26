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

import { randomUUID } from 'node:crypto'
import { parseRange, rangeHeaderOf, route } from '../kit/typescript/index.ts'
import type { Ctx, JsonValue, KitRoute, Reply } from '../kit/typescript/index.ts'
import type { C } from './config.ts'
import {
  deleteFolder,
  deleteObject,
  objectAt,
  objects,
  putXorb,
  registerShard,
  writeObject,
  xetFile,
} from './store.ts'
import { clampedReply, fileEntry, notFound, selfUrl, strip, treeEntries } from './wire.ts'
import { SERVE_CHUNK_SIZE, serializeChunks, serializedOffsetOf, serveHash } from './xet.ts'

const BOOT = randomUUID().replace(/-/g, '').slice(0, 12)

function bucketOf(ctx: Ctx<C>): string {
  return `${ctx.params.ns ?? ''}/${ctx.params.name ?? ''}`
}

function stamp(ctx: Ctx<C>): string {
  return ctx.clock.nowIso(false)
}

function headerOf(ctx: Ctx<C>, name: string): string {
  const raw = ctx.headers[name]
  const one = Array.isArray(raw) ? raw[0] : raw
  return one ?? ''
}

function truthy(value: string | null): boolean {
  return value !== null && ['true', '1'].includes(value.toLowerCase())
}

async function tree(ctx: Ctx<C>): Promise<Reply> {
  const rows = await objects(ctx.db, ctx.tenant, bucketOf(ctx))
  const entries = treeEntries(rows, ctx.params.path ?? '', truthy(ctx.query.get('recursive')))
  return { status: 200, body: entries }
}

// The vendor's stat probe. It answers the Xet hash and the content's real
// length in its own headers, and the kit fills Content-Length from the body it
// is handed -- which is why the whole content is returned here even though a
// HEAD never sends it. A `body: undefined` would answer Content-Length: 0.
function resolveHead(row: { content: Uint8Array }): Reply {
  const hash = serveHash(row.content)
  return {
    status: 200,
    body: Buffer.from(row.content),
    headers: {
      'X-Xet-Hash': hash,
      'X-Linked-Size': String(row.content.length),
      'X-Linked-ETag': `"${hash}"`,
      'Accept-Ranges': 'bytes',
    },
  }
}

async function resolveStat(ctx: Ctx<C>): Promise<Reply> {
  const row = await objectAt(ctx.db, ctx.tenant, bucketOf(ctx), strip(ctx.params.path ?? ''))
  return row === null ? notFound() : resolveHead(row)
}

// The real Hub 302s to its CDN bridge and the client follows; serving the bytes
// from here instead would leave the redirect path untested.
async function resolveGet(ctx: Ctx<C>): Promise<Reply> {
  const row = await objectAt(ctx.db, ctx.tenant, bucketOf(ctx), strip(ctx.params.path ?? ''))
  if (row === null) return notFound()
  const head = resolveHead(row)
  const hash = serveHash(row.content)
  return {
    status: 302,
    headers: { ...head.headers, Location: selfUrl(ctx, `/cdn/${bucketOf(ctx)}/${hash}`) },
  }
}

// The CDN answers with the file's xet hash as its strong ETag, whole or
// ranged, and a window starting at or past EOF is 416 with no ETag (both
// measured against huggingface.co, 2026-09-25). mirage reads a bucket file
// here and stamps that ETag as the content token stat reports, so an answer
// without it would pass every case by refetching each time. The clamp below
// is for the rest of the window: a range running past EOF comes back short.
async function cdn(ctx: Ctx<C>): Promise<Reply> {
  const hash = ctx.params.hash ?? ''
  const content = await xetFile(ctx.db, hash)
  if (content === null) return { status: 404 }
  const header = rangeHeaderOf(ctx.headers)
  if (header?.startsWith('bytes=') === true) {
    const first = header.slice('bytes='.length).split('-')[0] ?? ''
    if (first !== '' && Number(first) >= content.length) return { status: 416 }
  }
  const reply = clampedReply(ctx.headers, content, true)
  return { ...reply, headers: { ...reply.headers, ETag: `"${hash}"` } }
}

/**
 * The paths this request asks about.
 *
 * The vendor takes a form here, one `paths` field per entry. A JSON body is
 * accepted too because the documented shape is `{"paths": [...]}` and a client
 * that sends it should not read as asking about nothing. Anything else throws:
 * answering an empty list for a body we did not understand would report every
 * path as missing, which is a wrong answer wearing a valid one's clothes.
 *
 * Args:
 *   ctx (Ctx<C>): the request being answered.
 */
function requestedPaths(ctx: Ctx<C>): string[] {
  if (ctx.body.length === 0) return []
  if (headerOf(ctx, 'content-type').includes('json')) {
    const body = ctx.json()
    const named = Array.isArray(body) ? body : ((body as Record<string, JsonValue>).paths ?? [])
    if (!Array.isArray(named)) throw new Error('paths-info: `paths` is not a list')
    return named.map((p) => String(p))
  }
  const form = new URLSearchParams(ctx.body.toString('utf8'))
  const named = form.getAll('paths')
  if (named.length === 0) throw new Error(`paths-info: no paths in a ${ctx.body.length}-byte body`)
  return named
}

async function pathsInfo(ctx: Ctx<C>): Promise<Reply> {
  const bucket = bucketOf(ctx)
  const entries: Record<string, JsonValue>[] = []
  // Exact names only, and files only: the Hub answers `[]` for a directory
  // and for a leading-slash spelling of a file (measured 2026-09-25), and a
  // fake that normalised either would pass a key production never finds.
  for (const raw of requestedPaths(ctx)) {
    const row = await objectAt(ctx.db, ctx.tenant, bucket, raw)
    if (row !== null) entries.push(fileEntry(row))
  }
  return { status: 200, body: entries }
}

// The CAS is reached with its own credential, which this endpoint mints. It is
// the caller's own account name, which is not what selects the content (the CAS
// is not tenanted) but keeps the two halves of one session legible in a request
// log, and is the only thing a CAS call says about who is asking.
//
// The url carries BOOT, a nonce minted once per process, and that segment is
// load-bearing rather than decorative. The client caches uploaded shards under
// a directory named for the CAS endpoint and, on a later write of content it
// finds there, commits WITHOUT re-uploading the blocks. This fake's CAS lives in
// a SQLite file it recreates at startup, so a fixed url let a cache outlive the
// content it described: after any restart the next write committed a file whose
// bytes the fake had never received, and reads of it 404'd. A new url per
// process is the honest statement that this is a new CAS.
function xetToken(ctx: Ctx<C>): Reply {
  return {
    status: 200,
    body: {
      accessToken: ctx.tenant,
      casUrl: `${ctx.url.origin}/cas/${BOOT}`,
      exp: 9_999_999_999,
    },
  }
}

async function batch(ctx: Ctx<C>): Promise<Reply> {
  const bucket = bucketOf(ctx)
  for (const line of ctx.body.toString('utf8').split('\n')) {
    if (line.trim() === '') continue
    const op = JSON.parse(line) as Record<string, JsonValue>
    const path = strip(String(op.path ?? ''))
    if (op.type === 'addFile') {
      const hash = String(op.xetHash ?? '')
      const content = await xetFile(ctx.db, hash)
      if (content === null) return { status: 400, body: { error: `unknown xetHash ${hash}` } }
      await writeObject(
        ctx.db,
        ctx.tenant,
        bucket,
        path,
        Buffer.from(content),
        stamp(ctx),
        ctx.minter,
      )
    } else if (op.type === 'deleteFile') {
      await deleteObject(ctx.db, ctx.tenant, bucket, path)
    } else if (op.type === 'deleteFolder') {
      await deleteFolder(ctx.db, ctx.tenant, bucket, path)
    } else {
      return { status: 400, body: { error: `unsupported batch op ${String(op.type)}` } }
    }
  }
  return { status: 200, body: { success: true } }
}

// Global dedup lookup: always a miss, so clients upload their xorbs and the
// upload path is what the battery exercises.
function casChunks(): Reply {
  return { status: 404 }
}

async function casXorb(ctx: Ctx<C>): Promise<Reply> {
  await putXorb(ctx.db, ctx.params.hash ?? '', ctx.body)
  return { status: 200, body: { was_inserted: true } }
}

async function casShard(ctx: Ctx<C>): Promise<Reply> {
  await registerShard(ctx.db, ctx.body)
  return { status: 200, body: { result: 1 } }
}

// Only the V1 protocol is served; clients probe V2 first and fall back.
function casReconstructionV2(): Reply {
  return { status: 404 }
}

async function casReconstruction(ctx: Ctx<C>): Promise<Reply> {
  const hash = ctx.params.hash ?? ''
  const content = await xetFile(ctx.db, hash)
  if (content === null) return { status: 404 }
  const header = rangeHeaderOf(ctx.headers)
  const window = parseRange(header, content.length)
  if (window === 'unsatisfiable') {
    // An over-EOF segment probe is end-of-file to the client, which reads the
    // 416 as "nothing more" (xet-client's remote_client maps it to None).
    return { status: 416 }
  }
  const start = window === null ? 0 : window.start
  const end = window === null ? content.length : window.end
  if (start >= content.length) {
    return { status: 200, body: { offset_into_first_range: 0, terms: [], fetch_info: {} } }
  }
  const chunkFirst = Math.floor(start / SERVE_CHUNK_SIZE)
  const chunkLast = Math.max(chunkFirst, Math.floor((Math.max(end, 1) - 1) / SERVE_CHUNK_SIZE))
  const span = content.slice(chunkFirst * SERVE_CHUNK_SIZE, (chunkLast + 1) * SERVE_CHUNK_SIZE)
  let serializedLen = 0
  for (let i = chunkFirst; i <= chunkLast; i += 1) {
    serializedLen += 8 + content.slice(i * SERVE_CHUNK_SIZE, (i + 1) * SERVE_CHUNK_SIZE).length
  }
  // One term spanning the whole contiguous chunk range, mirroring xet-client's
  // own simulation server, which emits one term per xorb segment.
  const chunkRange = { start: chunkFirst, end: chunkLast + 1 }
  const from = serializedOffsetOf(chunkFirst)
  return {
    status: 200,
    body: {
      offset_into_first_range: start - chunkFirst * SERVE_CHUNK_SIZE,
      terms: [{ hash, unpacked_length: span.length, range: chunkRange }],
      fetch_info: {
        [hash]: [
          {
            range: chunkRange,
            url: selfUrl(ctx, `/cas/data/${hash}`),
            url_range: { start: from, end: from + serializedLen - 1 },
          },
        ],
      },
    },
  }
}

// The synthetic serialized xorb the reconstruction's fetch_info points at: the
// same content re-cut into scheme-0 chunks, so a client that asks for a byte
// range of the serialization gets exactly the chunks it was promised.
async function casData(ctx: Ctx<C>): Promise<Reply> {
  const content = await xetFile(ctx.db, ctx.params.hash ?? '')
  if (content === null) return { status: 404 }
  // No Content-Range here: this body is the fake's own serialization, and the
  // client reads exactly the url_range the reconstruction handed it.
  return clampedReply(ctx.headers, serializeChunks(content), false)
}

export function hfRoutes(): KitRoute<C>[] {
  return [
    // HEAD is declared ahead of the GET it shares a path with, because the
    // router falls back to a GET route for a HEAD and these two answer
    // differently: a stat gets the headers, a fetch gets the redirect.
    route<C>('HEAD', '/buckets/:ns/:name/resolve/*path', resolveStat),
    route<C>('GET', '/buckets/:ns/:name/resolve/*path', resolveGet),
    route<C>('GET', '/api/buckets/:ns/:name/tree/*path', tree),
    route<C>('POST', '/api/buckets/:ns/:name/paths-info', pathsInfo),
    route<C>('GET', '/api/buckets/:ns/:name/xet-read-token', xetToken),
    route<C>('GET', '/api/buckets/:ns/:name/xet-write-token', xetToken),
    route<C>('POST', '/api/buckets/:ns/:name/batch', batch, { write: true }),
    route<C>('GET', '/cdn/:ns/:name/:hash', cdn),
    // `:boot` is whatever nonce xetToken handed out. It is never read: it is
    // there to make the url the client caches under change when this process
    // does, and the routes have to accept it because the client builds every
    // CAS path by appending to that url. `/cas/data` is the fake's own link and
    // needs no nonce, and cannot be shadowed: no hash spells `shards`.
    route<C>('GET', '/cas/:boot/v1/chunks/:prefix/:hash', casChunks),
    route<C>('POST', '/cas/:boot/v1/xorbs/:prefix/:hash', casXorb, { write: true }),
    route<C>('POST', '/cas/:boot/shards', casShard, { write: true }),
    route<C>('GET', '/cas/:boot/v2/reconstructions/:hash', casReconstructionV2),
    route<C>('GET', '/cas/:boot/v1/reconstructions/:hash', casReconstruction),
    route<C>('GET', '/cas/data/:hash', casData),
  ]
}
