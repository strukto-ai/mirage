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

import { createHash } from 'node:crypto'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'

// The Hub answers these to a paths-info body it cannot read as JSON, which is
// what an untyped fetch body is (measured against huggingface.co, 2026-09-24).
export const INVALID_PATHS = '✖ Invalid input\n  → at paths'

const ENC = new TextEncoder()

export const BUCKETS = 'buckets'

/** An `etags` value that makes a bucket's CDN answer send no ETag at all. */
export const NO_ETAG = '<no etag>'

export const UPLOADED_AT = '2026-07-15T14:26:59.811Z'

function concat(...parts: Uint8Array[]): Uint8Array {
  return Buffer.concat(parts.map((p) => Buffer.from(p)))
}

export function blobOid(data: Uint8Array): string {
  return createHash('sha1')
    .update(concat(ENC.encode(`blob ${String(data.byteLength)}\0`), data))
    .digest('hex')
}

export function lfsOid(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export function xetHash(data: Uint8Array): string {
  return createHash('sha256')
    .update(concat(ENC.encode('xet:'), data))
    .digest('hex')
}

export function dirOid(path: string): string {
  return createHash('sha1').update(`tree ${path}`).digest('hex')
}

type Row = Record<string, unknown>

function dirRow(path: string): Row {
  return { type: 'directory', oid: dirOid(path), size: 0, path }
}

/**
 * A Hugging Face Hub on a local port, for tests that need the wire.
 *
 * Twin of python/tests/fixtures/hf_hub_api.py. Speaks tree, paths-info and
 * resolve the way the live Hub does: a missing subtree is 404 EntryNotFound, a
 * paths-info body that is not JSON is 400, and resolve answers a redirect whose
 * first hop carries a different ETag from the bytes it leads to. A real server
 * rather than a stubbed fetch, because only a real one makes fetch follow a
 * 302. Files are Xet-shaped unless `xet` is off, so the final ETag is the xet
 * hash rather than the git oid.
 *
 * Buckets live under `files('buckets', id)` and speak the bucket wire,
 * measured against huggingface.co on 2026-09-25: routes carry no revision,
 * paths-info matches paths exactly and answers only file rows (a directory or
 * a leading-slash path is `[]`), rows are `{type, path, size, xetHash,
 * uploadedAt}`, the CDN's strong ETag is the xet hash whatever `xet` says, and
 * a range starting at or past EOF is 416 with no ETag. A bucket's `etags`
 * override is sent verbatim, and `NO_ETAG` omits the header.
 */
export class FakeHub {
  /** `${api segment}|${repo id}` to path to bytes. */
  readonly repos = new Map<string, Map<string, Uint8Array>>()
  xet = true
  /** Path to the bytes the tree and paths-info describe instead. */
  readonly listed = new Map<string, Uint8Array>()
  /** Path to the final ETag resolve serves instead. */
  readonly etags = new Map<string, string>()
  /** Route name to the [status, error code] it answers. */
  readonly fail = new Map<string, [number, string]>()
  readonly log: [string, string][] = []
  readonly posts: { contentType: string; body: string }[] = []
  /** Bucket route name to the `Authorization` header of each request, '' if none. */
  readonly auth = new Map<string, string[]>()
  /** When set, bucket paths-info answers this body verbatim instead. */
  bucketAnswer: unknown = undefined
  /** `[route, status]` of every bucket CDN answer. */
  readonly statuses: [string, number][] = []
  url = ''
  private server: Server | null = null

  files(segment = 'models', repoId = 'acme/widget'): Map<string, Uint8Array> {
    const key = `${segment}|${repoId}`
    let files = this.repos.get(key)
    if (files === undefined) {
      files = new Map()
      this.repos.set(key, files)
    }
    return files
  }

  count(route: string): number {
    return this.log.filter(([name]) => name === route).length
  }

  row(path: string, served: Uint8Array): Row {
    const data = this.listed.get(path) ?? served
    const row: Row = { type: 'file', oid: blobOid(data), size: data.byteLength, path }
    if (this.xet) {
      row.lfs = { oid: lfsOid(data), size: data.byteLength, pointerSize: 134 }
      row.xetHash = xetHash(data)
    }
    return row
  }

  etag(path: string, data: Uint8Array): string {
    return this.etags.get(path) ?? (this.xet ? xetHash(data) : blobOid(data))
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      void this.handle(req, res)
    })
    await new Promise<void>((done) => this.server?.listen(0, '127.0.0.1', done))
    const port = (this.server.address() as AddressInfo).port
    this.url = `http://127.0.0.1:${String(port)}`
    return this
  }

  async close(): Promise<void> {
    const server = this.server
    if (server === null) return
    this.server = null
    server.closeAllConnections()
    await new Promise<void>((done) =>
      server.close(() => {
        done()
      }),
    )
  }

  private refused(route: string, res: ServerResponse): boolean {
    const failure = this.fail.get(route)
    if (failure === undefined) return false
    error(res, failure[0], failure[1], `fake ${route} refused`)
    return true
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x')
    const parts = url.pathname.split('/').slice(1).map(decodeURIComponent)
    if (parts[0] === 'api' && parts[1] === BUCKETS && parts[4] === 'paths-info') {
      await this.bucketPathsInfo(parts, req, res)
      return
    }
    if (parts[0] === BUCKETS && parts[3] === 'resolve') {
      this.bucketResolve(parts, req, res)
      return
    }
    if (parts[0] === 'cdn' && parts[1] === BUCKETS) {
      this.bucketCdn(parts, req, res)
      return
    }
    if (parts[0] === 'api' && parts[4] === 'tree') {
      this.tree(parts, res)
      return
    }
    if (parts[0] === 'api' && parts[4] === 'paths-info' && req.method === 'POST') {
      await this.pathsInfo(parts, req, res)
      return
    }
    if (parts[0] === 'cdn') {
      this.cdn(parts, req, res)
      return
    }
    const seg = parts[0] === 'datasets' || parts[0] === 'spaces' ? parts[0] : 'models'
    const rest = seg === 'models' ? parts : parts.slice(1)
    if (rest[2] === 'resolve') {
      this.resolve(seg, rest, res)
      return
    }
    error(res, 404, '', 'no route')
  }

  private repo(seg: string, ns: string | undefined, name: string | undefined) {
    return this.repos.get(`${seg}|${ns ?? ''}/${name ?? ''}`)
  }

  private tree(parts: string[], res: ServerResponse): void {
    const prefix = parts
      .slice(6)
      .join('/')
      .replace(/^\/+|\/+$/g, '')
    this.log.push(['tree', prefix])
    if (this.refused('tree', res)) return
    const files = this.repo(parts[1] ?? '', parts[2], parts[3])
    if (files === undefined) {
      error(res, 404, 'RepoNotFound', 'Repository not found')
      return
    }
    const under = prefix === '' ? '' : `${prefix}/`
    const rows = [...files].filter(([p]) => p.startsWith(under)).map(([p, d]) => this.row(p, d))
    if (prefix !== '' && rows.length === 0) {
      error(res, 404, 'EntryNotFound', `${prefix} does not exist on "main"`)
      return
    }
    const dirs = new Set<string>()
    for (const p of files.keys()) {
      if (p.startsWith(under) && p.slice(under.length).includes('/'))
        dirs.add(p.slice(0, p.lastIndexOf('/')))
    }
    json(res, 200, [...[...dirs].sort(compareCodePoints).map(dirRow), ...rows])
  }

  private async pathsInfo(
    parts: string[],
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks).toString()
    const kind = req.headers['content-type'] ?? ''
    this.posts.push({ contentType: kind, body })
    this.log.push(['paths_info', body])
    if (this.refused('paths_info', res)) return
    if (!kind.includes('json')) {
      json(res, 400, { error: INVALID_PATHS })
      return
    }
    const files = this.repo(parts[1] ?? '', parts[2], parts[3])
    if (files === undefined) {
      error(res, 404, 'RepoNotFound', 'Repository not found')
      return
    }
    const rows: Row[] = []
    for (const path of (JSON.parse(body) as { paths?: string[] }).paths ?? []) {
      const data = files.get(path)
      if (data !== undefined) rows.push(this.row(path, data))
      else if ([...files.keys()].some((p) => p.startsWith(`${path.replace(/\/+$/, '')}/`)))
        rows.push(dirRow(path.replace(/\/+$/, '')))
    }
    json(res, 200, rows)
  }

  private resolve(seg: string, rest: string[], res: ServerResponse): void {
    const [ns, name] = rest
    const path = rest.slice(4).join('/')
    this.log.push(['resolve', path])
    if (this.refused('resolve', res)) return
    const data = this.repo(seg, ns, name)?.get(path)
    if (data === undefined) {
      error(res, 404, 'EntryNotFound', `${path} not found`)
      return
    }
    // The first hop names the LFS sha, never the bytes' own ETag, so a client
    // that read the wrong hop reads the wrong token.
    res.writeHead(302, {
      Location: `/cdn/${seg}/${ns ?? ''}/${name ?? ''}/${rest.slice(4).map(encodeURIComponent).join('/')}`,
      'X-Linked-Etag': `"${lfsOid(data)}"`,
    })
    res.end()
  }

  private heard(route: string, req: IncomingMessage): void {
    const seen = this.auth.get(route) ?? []
    seen.push(req.headers.authorization ?? '')
    this.auth.set(route, seen)
  }

  private async bucketPathsInfo(
    parts: string[],
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks).toString()
    const kind = req.headers['content-type'] ?? ''
    this.posts.push({ contentType: kind, body })
    this.log.push(['bucket_paths_info', body])
    this.heard('bucket_paths_info', req)
    if (this.refused('bucket_paths_info', res)) return
    if (!kind.includes('json')) {
      json(res, 400, { error: INVALID_PATHS })
      return
    }
    if (this.bucketAnswer !== undefined) {
      json(res, 200, this.bucketAnswer)
      return
    }
    const files = this.repo(BUCKETS, parts[2], parts[3])
    if (files === undefined) {
      error(res, 404, 'RepoNotFound', 'Repository not found')
      return
    }
    const rows: Row[] = []
    for (const path of (JSON.parse(body) as { paths?: string[] }).paths ?? []) {
      const data = files.get(path)
      if (data === undefined) continue
      rows.push({
        type: 'file',
        path,
        size: data.byteLength,
        xetHash: xetHash(data),
        uploadedAt: UPLOADED_AT,
      })
    }
    json(res, 200, rows)
  }

  private bucketResolve(parts: string[], req: IncomingMessage, res: ServerResponse): void {
    const [, ns, name] = parts
    const rest = parts.slice(4)
    const path = rest.join('/')
    this.log.push(['bucket_resolve', path])
    this.heard('bucket_resolve', req)
    if (this.refused('bucket_resolve', res)) return
    const data = this.repo(BUCKETS, ns, name)?.get(path)
    if (data === undefined) {
      error(res, 404, 'EntryNotFound', 'File not found')
      return
    }
    res.writeHead(302, {
      Location: `/cdn/${BUCKETS}/${ns ?? ''}/${name ?? ''}/${rest.map(encodeURIComponent).join('/')}`,
      'X-Linked-Etag': `"${xetHash(data)}"`,
    })
    res.end()
  }

  private bucketCdn(parts: string[], req: IncomingMessage, res: ServerResponse): void {
    const path = parts.slice(4).join('/')
    const data = this.repo(BUCKETS, parts[2], parts[3])?.get(path) ?? new Uint8Array()
    const etag = this.etags.get(path) ?? `"${xetHash(data)}"`
    const headers: Record<string, string> = etag === NO_ETAG ? {} : { ETag: etag }
    const span = req.headers.range ?? ''
    if (span.startsWith('bytes=')) {
      const [first = '', last = ''] = span.slice('bytes='.length).split('-')
      const start = Number(first)
      if (start >= data.byteLength) {
        this.statuses.push(['bucket_cdn', 416])
        res.writeHead(416)
        res.end()
        return
      }
      const end = Math.min(last === '' ? data.byteLength : Number(last) + 1, data.byteLength)
      this.statuses.push(['bucket_cdn', 206])
      res.writeHead(206, headers)
      res.end(Buffer.from(data.slice(start, end)))
      return
    }
    this.statuses.push(['bucket_cdn', 200])
    res.writeHead(200, headers)
    res.end(Buffer.from(data))
  }

  private cdn(parts: string[], req: IncomingMessage, res: ServerResponse): void {
    const path = parts.slice(4).join('/')
    const data = this.repo(parts[1] ?? '', parts[2], parts[3])?.get(path) ?? new Uint8Array()
    const headers = { ETag: `"${this.etag(path, data)}"` }
    const span = req.headers.range ?? ''
    if (span.startsWith('bytes=')) {
      const [first, last] = span.slice('bytes='.length).split('-')
      const end = last === undefined || last === '' ? data.byteLength : Number(last) + 1
      res.writeHead(206, headers)
      res.end(Buffer.from(data.slice(Number(first), end)))
      return
    }
    res.writeHead(200, headers)
    res.end(Buffer.from(data))
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function error(res: ServerResponse, status: number, code: string, message: string): void {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Error-Message': message,
  }
  if (code !== '') headers['X-Error-Code'] = code
  res.writeHead(status, headers)
  res.end(JSON.stringify({ error: message }))
}

/** Start a fake Hub on a free local port; close it with `hub.close()`. */
export async function serveHub(hub: FakeHub = new FakeHub()): Promise<FakeHub> {
  return hub.start()
}
