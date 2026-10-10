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

import { GitHubAccessor } from '../../accessor/github.ts'
import type {
  Evicted,
  IndexEntry,
  ListResult,
  LookupResult,
  SetDirOptions,
} from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { HttpGitHubTransport } from './client.ts'
import { CODE_SEARCH_SIZE_LIMIT } from './constants.ts'
import { refillSnapshot } from './tree.ts'
import { sha1Hex } from '../../utils/hash.ts'
import { compareCodePoints } from '../../utils/sort.ts'

export const BASE = 'http://github.test'
const ENC = new TextEncoder()
const SHA40 = /^[0-9a-fA-F]{40}$/

export async function blobSha(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? ENC.encode(data) : data
  const head = ENC.encode(`blob ${String(bytes.length)}\0`)
  const all = new Uint8Array(head.length + bytes.length)
  all.set(head)
  all.set(bytes, head.length)
  return sha1Hex(all)
}

function sha40(segment: string): string | null {
  return SHA40.test(segment) ? segment.toLowerCase() : null
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** The files of one commit, as the fake serves them. */
export class Snapshot {
  constructor(
    readonly files: ReadonlyMap<string, Uint8Array>,
    readonly symlinks: ReadonlySet<string>,
  ) {}

  mode(path: string): string {
    return this.symlinks.has(path) ? '120000' : '100644'
  }

  dirs(): Set<string> {
    const out = new Set<string>()
    for (const path of this.files.keys()) {
      const parts = path.split('/').slice(0, -1)
      for (let i = 1; i <= parts.length; i += 1) out.add(parts.slice(0, i).join('/'))
    }
    return out
  }

  async head(): Promise<string> {
    const rows = await Promise.all(
      [...this.files].map(
        async ([path, data]) => `${path}\0${this.mode(path)}\0${await blobSha(data)}`,
      ),
    )
    return sha1Hex(ENC.encode(`commit ${rows.sort(compareCodePoints).join('\n')}`))
  }

  async treeIds(): Promise<Map<string, string>> {
    const children = new Map<string, Map<string, [string, string]>>([['', new Map()]])
    for (const at of this.dirs()) children.set(at, new Map())
    for (const [path, data] of this.files) {
      const cut = path.lastIndexOf('/')
      children
        .get(cut < 0 ? '' : path.slice(0, cut))
        ?.set(path.slice(cut + 1), [this.mode(path), await blobSha(data)])
    }
    const depth = (d: string): number => (d === '' ? -1 : d.split('/').length - 1)
    const ids = new Map<string, string>()
    for (const at of [...children.keys()].sort((a, b) => depth(b) - depth(a))) {
      const rows = [...(children.get(at) ?? [])].sort(([a], [b]) => compareCodePoints(a, b))
      const body = concat(
        rows.flatMap(([name, [mode, sha]]) => [ENC.encode(`${mode} ${name}\0`), hexBytes(sha)]),
      )
      const id = await sha1Hex(concat([ENC.encode(`tree ${String(body.length)}\0`), body]))
      ids.set(at, id)
      if (at !== '') {
        const cut = at.lastIndexOf('/')
        children.get(cut < 0 ? '' : at.slice(0, cut))?.set(at.slice(cut + 1), ['40000', id])
      }
    }
    return ids
  }
}

/**
 * A GitHub repository behind a `fetch` router, for tests that need the wire.
 *
 * The TypeScript twin of python's tests/fixtures/github_api.py. Speaks the
 * four calls the github mount makes the way the live API does (measured with
 * `gh api`, X-GitHub-Api-Version 2022-11-28, 2026-09-25): the recursive tree
 * of a ref, the shallow tree of `{ref}:{dir}` (404 for a missing directory or
 * ref, 422 when a path component is a file, a symlink row carrying the link's
 * own sha and length), the shallow tree of a tree sha, and a blob by sha.
 * Shas are real git blob shas, so different bytes always name a different
 * blob, and a blob once served stays readable after the file changes.
 *
 * A tree asked by ref answers the head commit as its top-level `sha`, as
 * GitHub does (measured 2026-09-30), and `{ref}:` answers the root tree. Both
 * derive from the files at request time, so a test that edits `files`
 * directly moves them. A folder's sha is the git tree sha over its children,
 * so it moves only when something under it changes. Every head and tree the
 * fake answers is remembered with the files it named: a head is served as
 * `{sha}`, `{sha}:{dir}` and recursively, in either case and answered in
 * lowercase, and a folder sha keeps listing what that folder held.
 *
 * The segment after `git/trees/` is routed only as one path segment, so a
 * request whose `/` inside it went unencoded is not routed and 404s, and one
 * Octokit rewrote (`main:src` sent as `main`) asks for the root instead.
 *
 * Truncating a shallow listing (`truncatedDirs`) is defensive, not
 * measured: no single directory sampled was large enough to truncate.
 */
function holdsWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u').test(text)
}

export class FakeGitHub {
  readonly files: Map<string, Uint8Array>
  readonly symlinks = new Set<string>()
  ref = 'main'
  truncatedRecursive = false
  readonly truncatedDirs = new Map<string, number>()
  readonly fail = new Map<string, [number, string]>()
  // Called once a recursive tree response is built, so a test can change
  // the repository between two fetches of one line.
  afterRecursive: (() => void) | null = null
  // A recursive fetch waits on it before answering, so a test can line
  // readers up.
  holdRecursive: Promise<void> | null = null
  // Answer the recursive tree with no top-level `sha`, the shape of a
  // response that names no version.
  dropSha = false
  // Called once the shallow tree of `ref` is built, so a test can change the
  // repository right after a head was answered.
  afterHead: (() => void) | null = null
  // The shallow tree of `ref` waits on it before answering, while other
  // requests are served.
  holdDir: Promise<void> | null = null
  readonly log: [string, string][] = []
  readonly history = new Map<string, Snapshot>()
  readonly trees = new Map<string, [Snapshot, string]>()
  private readonly blobs = new Map<string, Uint8Array>()
  readonly url = BASE

  constructor(files: Record<string, string | Uint8Array> = {}) {
    this.files = new Map(
      Object.entries(files).map(([path, data]) => [
        path,
        typeof data === 'string' ? ENC.encode(data) : data,
      ]),
    )
  }

  set(path: string, data: string | Uint8Array): void {
    this.files.set(path, typeof data === 'string' ? ENC.encode(data) : data)
  }

  count(route: string): number {
    return this.log.filter(([name]) => name === route).length
  }

  counts(): [number, number, number] {
    return [this.count('dir'), this.count('recursive'), this.count('blob')]
  }

  snapshot(): Snapshot {
    return new Snapshot(new Map(this.files), new Set(this.symlinks))
  }

  head(): Promise<string> {
    return this.snapshot().head()
  }

  private async remember(snap: Snapshot): Promise<void> {
    const head = await snap.head()
    if (!this.history.has(head)) this.history.set(head, snap)
    for (const [at, sha] of await snap.treeIds()) {
      if (!this.trees.has(sha)) this.trees.set(sha, [snap, at])
    }
  }

  private async commit(rev: string): Promise<Snapshot | null> {
    if (rev === this.ref) return this.snapshot()
    const sha = sha40(rev)
    if (sha === null) return null
    const current = this.snapshot()
    if (sha === (await current.head())) return current
    return this.history.get(sha) ?? null
  }

  private async namedTree(segment: string): Promise<[Snapshot, string] | null> {
    const sha = sha40(segment)
    if (sha === null) return null
    const current = this.snapshot()
    for (const [at, id] of await current.treeIds()) if (id === sha) return [current, at]
    return this.trees.get(sha) ?? null
  }

  private async row(
    snap: Snapshot,
    ids: Map<string, string>,
    path: string,
    name: string,
  ): Promise<Record<string, unknown>> {
    const data = snap.files.get(path)
    if (data === undefined) {
      return { path: name, mode: '040000', type: 'tree', sha: ids.get(path) }
    }
    const sha = await blobSha(data)
    this.blobs.set(sha, data)
    return { path: name, mode: snap.mode(path), type: 'blob', sha, size: data.length }
  }

  private async shallow(
    snap: Snapshot,
    ids: Map<string, string>,
    at: string,
  ): Promise<Record<string, unknown>[]> {
    const prefix = at === '' ? '' : `${at}/`
    const names = new Set<string>()
    for (const path of [...snap.files.keys(), ...snap.dirs()]) {
      if (!path.startsWith(prefix) || path === at) continue
      names.add(path.slice(prefix.length).split('/')[0] ?? '')
    }
    return Promise.all(
      [...names].sort(compareCodePoints).map((name) => this.row(snap, ids, prefix + name, name)),
    )
  }

  private refused(route: string): Response | null {
    const failure = this.fail.get(route)
    return failure === undefined ? null : json(failure[0], { message: failure[1] })
  }

  private async listing(
    route: string | null,
    raw: string,
    snap: Snapshot,
    at: string,
    head: string | null,
  ): Promise<Response> {
    if (route !== null) {
      this.log.push([route, raw])
      const refused = this.refused(route)
      if (refused !== null) return refused
    }
    await this.remember(snap)
    const ids = await snap.treeIds()
    let rows = await this.shallow(snap, ids, at)
    const keep = this.truncatedDirs.get(at)
    if (keep !== undefined) rows = rows.slice(0, keep)
    return json(200, { sha: head ?? ids.get(at), tree: rows, truncated: keep !== undefined })
  }

  private async headListing(raw: string): Promise<Response> {
    this.log.push(['dir', raw])
    const refused = this.refused('dir')
    if (refused !== null) return refused
    if (this.holdDir !== null) await this.holdDir
    const snap = this.snapshot()
    const response = await this.listing(null, raw, snap, '', await snap.head())
    this.afterHead?.()
    return response
  }

  private async recursive(raw: string, segment: string): Promise<Response> {
    this.log.push(['recursive', raw])
    const refused = this.refused('recursive')
    if (refused !== null) return refused
    let snap = await this.commit(segment)
    if (snap === null) return json(404, { message: 'Not Found' })
    if (this.holdRecursive !== null) {
      await this.holdRecursive
      if (segment === this.ref) snap = this.snapshot()
    }
    await this.remember(snap)
    const ids = await snap.treeIds()
    let paths = [...snap.files.keys(), ...snap.dirs()].sort(compareCodePoints)
    if (this.truncatedRecursive) paths = paths.filter((p) => !p.includes('/'))
    const tree = await Promise.all(paths.map((p) => this.row(snap, ids, p, p)))
    const response = json(200, {
      ...(this.dropSha ? {} : { sha: await snap.head() }),
      tree,
      truncated: this.truncatedRecursive,
    })
    this.afterRecursive?.()
    return response
  }

  private async point(raw: string, segment: string, colon: number): Promise<Response> {
    this.log.push(['dir', raw])
    const refused = this.refused('dir')
    if (refused !== null) return refused
    const snap = await this.commit(segment.slice(0, colon))
    if (snap === null) return json(404, { message: 'Not Found' })
    const at = segment.slice(colon + 1).replace(/^\/+|\/+$/g, '')
    const parts = at === '' ? [] : at.split('/')
    for (let depth = 1; depth <= parts.length; depth += 1) {
      if (snap.files.has(parts.slice(0, depth).join('/'))) {
        return json(422, {
          message: 'Invalid object requested. SHA must identify a commit or a tree.',
        })
      }
    }
    if (at !== '' && !snap.dirs().has(at)) return json(404, { message: 'Not Found' })
    return this.listing(null, raw, snap, at, null)
  }

  private async tree(raw: string, recursive: boolean): Promise<Response> {
    const segment = decodeURIComponent(raw)
    if (recursive) return this.recursive(raw, segment)
    const colon = segment.indexOf(':')
    if (colon >= 0) return this.point(raw, segment, colon)
    if (segment === this.ref) return this.headListing(raw)
    const snap = await this.commit(segment)
    if (snap !== null) return this.listing('dir', raw, snap, '', await snap.head())
    const named = await this.namedTree(segment)
    if (named === null) {
      this.log.push(['sha_dir', raw])
      return json(404, { message: 'Not Found' })
    }
    return this.listing('sha_dir', raw, named[0], named[1], null)
  }

  private async blob(sha: string): Promise<Response> {
    this.log.push(['blob', sha])
    const refused = this.refused('blob')
    if (refused !== null) return refused
    for (const data of this.files.values()) {
      const known = await blobSha(data)
      if (!this.blobs.has(known)) this.blobs.set(known, data)
    }
    const data = this.blobs.get(sha)
    if (data === undefined) return json(404, { message: 'Not Found' })
    let binary = ''
    for (const byte of data) binary += String.fromCharCode(byte)
    return json(200, { sha, size: data.length, encoding: 'base64', content: btoa(binary) })
  }

  // Code search reads `q` the way the REST endpoint does: the words
  // outside `repo:` and `path:` must each appear as a whole word, in any
  // case, in a file under 384 KB below `path:`; one page of `per_page`
  // rows carries the full `total_count`.
  private async searchCode(url: URL): Promise<Response> {
    const q = url.searchParams.get('q') ?? ''
    this.log.push(['search', q])
    const refused = this.refused('search')
    if (refused !== null) return refused
    const terms = q.split(/\s+/).filter((term) => term !== '')
    const repo = terms.find((term) => term.startsWith('repo:'))?.slice(5) ?? ''
    const scope = terms.find((term) => term.startsWith('path:'))?.slice(5) ?? ''
    const words = terms.filter((term) => !term.includes(':')).map((term) => term.toLowerCase())
    const hits = [...this.files.keys()].sort(compareCodePoints).filter((path) => {
      const data = this.files.get(path) ?? new Uint8Array()
      if (data.length >= CODE_SEARCH_SIZE_LIMIT) return false
      if (scope !== '' && !path.startsWith(`${scope.replace(/\/+$/, '')}/`)) return false
      const text = new TextDecoder().decode(data).toLowerCase()
      return words.every((word) => holdsWord(text, word))
    })
    const perPage = Number(url.searchParams.get('per_page') ?? '30')
    const items = await Promise.all(
      hits.slice(0, perPage).map(async (path) => ({
        path,
        sha: await blobSha(this.files.get(path) ?? new Uint8Array()),
        repository: { full_name: repo },
      })),
    )
    return json(200, { total_count: hits.length, incomplete_results: false, items })
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init)
    const url = new URL(req.url)
    const path = url.pathname
    if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) {
      this.log.push(['repo', ''])
      return this.refused('repo') ?? json(200, { default_branch: this.ref })
    }
    const tree = /^\/repos\/[^/]+\/[^/]+\/git\/trees\/(.+)$/.exec(path)
    if (tree !== null) {
      const raw = tree[1] ?? ''
      if (raw.includes('/')) return json(404, { message: 'Not Found' })
      return this.tree(raw, url.searchParams.get('recursive') === '1')
    }
    const blob = /^\/repos\/[^/]+\/[^/]+\/git\/blobs\/([^/]+)$/.exec(path)
    if (blob !== null) return this.blob(blob[1] ?? '')
    if (path === '/search/code') return this.searchCode(url)
    throw new Error(`FakeGitHub: unrouted ${req.method} ${req.url}`)
  }
}

export function servedAccessor(ref = 'main'): GitHubAccessor {
  return new GitHubAccessor({
    transport: new HttpGitHubTransport({ token: 't', baseUrl: BASE }),
    owner: 'o',
    repo: 'r',
    ref,
    defaultBranch: ref,
  })
}

// Each hook fires once, on the first listing of the nested parent, so the
// retry sees real data; a root child would let ensureLiveSnapshot's root probe
// consume it instead.
class ClearedAtList extends RAMIndexCacheStore {
  fired = false
  constructor(private readonly parent: string) {
    super()
  }
  override async listDir(path: string): Promise<ListResult> {
    if (!this.fired && path === this.parent) {
      this.fired = true
      await this.clear()
    }
    return super.listDir(path)
  }
}

class StaleListing extends RAMIndexCacheStore {
  fired = false
  accessor: GitHubAccessor | null = null
  constructor(
    private readonly parent: string,
    private readonly key: string,
  ) {
    super()
  }
  override async listDir(path: string): Promise<ListResult> {
    const result = await super.listDir(path)
    if (this.fired || path !== this.parent || this.accessor === null) return result
    this.fired = true
    const stale = (result.entries ?? []).filter((k) => k !== this.key)
    // Another op refills while this lookup holds the stale listing.
    await refillSnapshot(this.accessor, this, '/gh')
    return { ...result, entries: stale }
  }
}

class ClearedMidLookup extends RAMIndexCacheStore {
  fired = false
  override async get(path: string): Promise<LookupResult> {
    if (!this.fired) {
      this.fired = true
      await this.clear()
    }
    return super.get(path)
  }
}

class ClearedAndReseeded extends RAMIndexCacheStore {
  fired = false
  accessor: GitHubAccessor | null = null
  override async get(path: string): Promise<LookupResult> {
    if (this.fired || this.accessor === null) return super.get(path)
    this.fired = true
    await this.clear()
    const missed = await super.get(path)
    await refillSnapshot(this.accessor, this, '/gh')
    return missed
  }
}

export type RaceIndex = RAMIndexCacheStore & { fired: boolean; accessor?: GitHubAccessor | null }

/**
 * An index that changes under the lookup it serves, once.
 *
 * `list` clears at the parent listing, `stale` hands back a listing without
 * the key while another op refills, `get` clears at the entry read,
 * `reseed` clears and refills there so the root reads live.
 */
export function raceIndex(kind: 'list' | 'stale' | 'get' | 'reseed'): RaceIndex {
  if (kind === 'list') return new ClearedAtList('/gh/docs/sub')
  if (kind === 'stale') return new StaleListing('/gh/docs/sub', '/gh/docs/sub/b.txt')
  if (kind === 'get') return new ClearedMidLookup()
  return new ClearedAndReseeded()
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
