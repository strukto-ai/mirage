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
import type { Evicted, IndexEntry, SetDirOptions } from '@struktoai/mirage-core/cache/index/config'
import { RAMIndexCacheStore } from '@struktoai/mirage-core/cache/index/ram'
import type { DirListing} from '@struktoai/mirage-core/types';
import { type FileStat, PathSpec } from '@struktoai/mirage-core/types'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import { rstripSlash, stripSlash } from '@struktoai/mirage-core/utils/slash'
import { vi } from 'vitest'
import { HfHubAccessor } from '../../accessor/hf_hub.ts'
import * as client from './client.ts'
import { readdir } from './readdir.ts'

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

export function commitSha(
  segment: string,
  repoId: string,
  files: ReadonlyMap<string, Uint8Array>,
): string {
  const rows = [...files].map(([path, data]) => `${path}\0${blobOid(data)}`).sort(compareCodePoints)
  return createHash('sha1')
    .update(`commit ${segment}\0${repoId}\n${rows.join('\n')}`)
    .digest('hex')
}

function sha40(rev: string): string | null {
  return /^[0-9a-fA-F]{40}$/.test(rev) ? rev.toLowerCase() : null
}

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
 *
 * `/revision/{rev}` answers the repo object with the head commit as its `sha`,
 * derived per repo from the files at request time, so a test that edits
 * `files()` directly moves it; `expand[]=sha` trims the answer to
 * `{_id, id, sha}`. Every head the fake answers is remembered with the files
 * it named, and tree and paths-info at that sha serve them; a 40-hex rev the
 * fake never answered is 404 RevisionNotFound. Any other rev reads the
 * current files.
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
  /** `[route, path, rev, query]` of every request, rev and query '' where the route has none. */
  readonly log: [string, string, string, string][] = []
  /** Commit sha to the files it named. */
  readonly history = new Map<string, Map<string, Uint8Array>>()
  /** Extra revision names, 40-hex or not, that read the current files as `main` does. */
  readonly branches = new Set<string>()
  /** Run after each revision answer is built, to land a commit before the tree. */
  afterRevision: (() => void) | null = null
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

  head(segment = 'models', repoId = 'acme/widget'): string {
    return commitSha(segment, repoId, this.files(segment, repoId))
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
    const query = decodeURIComponent(url.search.slice(1))
    if (parts[0] === 'api' && parts[4] === 'tree') {
      this.tree(parts, query, res)
      return
    }
    if (parts[0] === 'api' && parts[4] === 'paths-info' && req.method === 'POST') {
      await this.pathsInfo(parts, query, req, res)
      return
    }
    if (parts[0] === 'api' && parts[4] === 'revision') {
      this.revision(parts, url, query, res)
      return
    }
    if (parts[0] === 'cdn') {
      this.cdn(parts, req, res)
      return
    }
    const seg = parts[0] === 'datasets' || parts[0] === 'spaces' ? parts[0] : 'models'
    const rest = seg === 'models' ? parts : parts.slice(1)
    if (rest[2] === 'resolve') {
      this.resolve(seg, rest, query, res)
      return
    }
    error(res, 404, '', 'no route')
  }

  private repo(seg: string, ns: string | undefined, name: string | undefined) {
    return this.repos.get(`${seg}|${ns ?? ''}/${name ?? ''}`)
  }

  private at(parts: string[], res: ServerResponse): Map<string, Uint8Array> | null {
    const files = this.repo(parts[1] ?? '', parts[2], parts[3])
    if (files === undefined) {
      error(res, 404, 'RepoNotFound', 'Repository not found')
      return null
    }
    const rev = parts[5] ?? ''
    const current = new Map(files)
    const head = commitSha(parts[1] ?? '', `${parts[2] ?? ''}/${parts[3] ?? ''}`, current)
    if (!this.history.has(head)) this.history.set(head, current)
    const sha = sha40(rev)
    if (sha === null || sha === head || this.branches.has(rev)) return current
    const old = this.history.get(sha)
    if (old !== undefined) return old
    error(res, 404, 'RevisionNotFound', `Invalid rev id: ${rev}`)
    return null
  }

  private revision(parts: string[], url: URL, query: string, res: ServerResponse): void {
    this.log.push(['revision', '', parts[5] ?? '', query])
    if (this.refused('revision', res)) return
    const files = this.at(parts, res)
    if (files === null) return
    const repoId = `${parts[2] ?? ''}/${parts[3] ?? ''}`
    const full: Record<string, unknown> = {
      _id: createHash('sha1').update(repoId).digest('hex').slice(0, 24),
      id: repoId,
      sha: commitSha(parts[1] ?? '', repoId, files),
      siblings: [...files.keys()].sort(compareCodePoints).map((rfilename) => ({ rfilename })),
    }
    this.afterRevision?.()
    const expand = url.searchParams.getAll('expand[]')
    if (expand.length === 0) {
      json(res, 200, full)
      return
    }
    const keep = new Set(['_id', 'id', ...expand])
    json(res, 200, Object.fromEntries(Object.entries(full).filter(([key]) => keep.has(key))))
  }

  private tree(parts: string[], query: string, res: ServerResponse): void {
    const prefix = stripSlash(parts.slice(6).join('/'))
    this.log.push(['tree', prefix, parts[5] ?? '', query])
    if (this.refused('tree', res)) return
    const files = this.at(parts, res)
    if (files === null) return
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
    query: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks).toString()
    const kind = req.headers['content-type'] ?? ''
    this.posts.push({ contentType: kind, body })
    this.log.push(['paths_info', body, parts[5] ?? '', query])
    if (this.refused('paths_info', res)) return
    if (!kind.includes('json')) {
      json(res, 400, { error: INVALID_PATHS })
      return
    }
    const files = this.at(parts, res)
    if (files === null) return
    const rows: Row[] = []
    for (const path of (JSON.parse(body) as { paths?: string[] }).paths ?? []) {
      const data = files.get(path)
      if (data !== undefined) rows.push(this.row(path, data))
      else if ([...files.keys()].some((p) => p.startsWith(`${rstripSlash(path)}/`)))
        rows.push(dirRow(rstripSlash(path)))
    }
    json(res, 200, rows)
  }

  private resolve(seg: string, rest: string[], query: string, res: ServerResponse): void {
    const [ns, name] = rest
    const path = rest.slice(4).join('/')
    this.log.push(['resolve', path, rest[3] ?? '', query])
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
    this.log.push(['bucket_paths_info', body, '', ''])
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
    this.log.push(['bucket_resolve', path, '', ''])
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

/** Expire every listing immediately except the optional live key. */
export class ExpiredOnArrival extends RAMIndexCacheStore {
  constructor(private readonly live: string | null = null) {
    super({ ttl: 86_400 })
  }

  private expiryFor(path: string, expiredAt?: Date | null): Date | null | undefined {
    return path === this.live ? expiredAt : new Date(0)
  }

  override setDir(
    path: string,
    entries: readonly [string, IndexEntry][],
    expiredAt?: Date | null,
    options?: SetDirOptions,
  ): Promise<Evicted[]> {
    return super.setDir(path, entries, this.expiryFor(path, expiredAt), options)
  }

  override setPartialDir(
    path: string,
    entries: readonly [string, IndexEntry][],
    expiredAt?: Date | null,
  ): Promise<void> {
    return super.setPartialDir(path, entries, this.expiryFor(path, expiredAt))
  }

  override seed(
    entries: ReadonlyMap<string, IndexEntry>,
    children: ReadonlyMap<string, readonly string[]>,
    expiresAt: Date,
    version: string | null = null,
  ): void {
    const live = [...children].filter(([path]) => path === this.live)
    super.seed(
      entries,
      new Map([...children].filter(([path]) => path !== this.live)),
      new Date(0),
      version,
    )
    super.seed(new Map(), new Map(live), expiresAt, version)
  }
}

/** A PathSpec for a mount-local path under an optional mount prefix. */
export function ps(path: string, prefix = ''): PathSpec {
  const rel = stripSlash(path)
  const stem = rstripSlash(prefix)
  const virtual =
    stem === '' ? (rel === '' ? '/' : `/${rel}`) : rel === '' ? stem : `${stem}/${rel}`
  const parent = virtual.slice(0, virtual.lastIndexOf('/')) || '/'
  return new PathSpec({ virtual, directory: parent, vfsPath: rel })
}

/** The errno an fs op refused with, which is what a backend test pins. */
export async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run()
  } catch (err) {
    return (err as { code?: string }).code
  }
  return undefined
}

function page(rows: unknown[]): {
  data: unknown[]
  status: number
  headers: Record<string, string>
} {
  return { data: rows, status: 200, headers: {} }
}

export const ROWS = [
  { type: 'file', oid: 'oid-a', size: 7, path: 'a.txt' },
  { type: 'file', oid: 'oid-b', size: 3, path: 'd/b.txt' },
  { type: 'directory', oid: 'tree-d', size: 0, path: 'd' },
]

/** An accessor whose tree walk answers `rows` locally. */
export function walking(rows: unknown[] = ROWS): HfHubAccessor {
  vi.spyOn(client, 'hubGetResponse').mockResolvedValue(page(rows))
  return new HfHubAccessor({ repoId: 'acme/widget' } as never)
}

/**
 * The row the folder holding `path` lists for it, as the mount finds it: a
 * listing of this backend is the whole tree, so one folder's listing names
 * any row below the root.
 */
export async function rowAt(accessor: HfHubAccessor, path: PathSpec): Promise<FileStat | null> {
  const rel = stripSlash(path.vfsPath)
  if (rel === '') return null
  const cut = rel.lastIndexOf('/')
  const folder = cut === -1 ? '' : rel.slice(0, cut)
  let listing: DirListing
  try {
    listing = await readdir(accessor, ps(folder))
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null
    throw err
  }
  return listing.entries.find((row) => row.name === rel.slice(cut + 1)) ?? null
}
