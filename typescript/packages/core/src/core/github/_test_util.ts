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
import type { ListResult, LookupResult } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { HttpGitHubTransport } from './client.ts'
import { refillIndex } from './tree.ts'
import { compareCodePoints } from '../../utils/sort.ts'

export const BASE = 'http://github.test'
const ENC = new TextEncoder()

export async function blobSha(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? ENC.encode(data) : data
  const head = ENC.encode(`blob ${String(bytes.length)}\0`)
  const all = new Uint8Array(head.length + bytes.length)
  all.set(head)
  all.set(bytes, head.length)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', all))
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Unique per directory and hex like a real tree sha, so it is one plain
// path segment; it only has to name the directory back to this fake.
export function treeSha(path: string): string {
  return [...ENC.encode(`tree ${path}`)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
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
 * The segment after `git/trees/` is routed only as one path segment, so a
 * request whose `/` inside it went unencoded is not routed and 404s, and one
 * Octokit rewrote (`main:src` sent as `main`) asks for the root instead.
 *
 * Truncating a shallow listing (`truncatedDirs`) is defensive, not
 * measured: no single directory sampled was large enough to truncate.
 */
export class FakeGitHub {
  readonly files: Map<string, Uint8Array>
  readonly symlinks = new Set<string>()
  ref = 'main'
  truncatedRecursive = false
  readonly truncatedDirs = new Map<string, number>()
  readonly fail = new Map<string, [number, string]>()
  readonly log: [string, string][] = []
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

  private dirs(): Set<string> {
    const out = new Set<string>()
    for (const path of this.files.keys()) {
      const parts = path.split('/').slice(0, -1)
      for (let i = 1; i <= parts.length; i += 1) out.add(parts.slice(0, i).join('/'))
    }
    return out
  }

  private async row(path: string, name: string): Promise<Record<string, unknown>> {
    const data = this.files.get(path)
    if (data === undefined) {
      return { path: name, mode: '040000', type: 'tree', sha: treeSha(path) }
    }
    const sha = await blobSha(data)
    this.blobs.set(sha, data)
    return {
      path: name,
      mode: this.symlinks.has(path) ? '120000' : '100644',
      type: 'blob',
      sha,
      size: data.length,
    }
  }

  private async shallow(at: string): Promise<Record<string, unknown>[]> {
    const prefix = at === '' ? '' : `${at}/`
    const names = new Set<string>()
    for (const path of [...this.files.keys(), ...this.dirs()]) {
      if (!path.startsWith(prefix) || path === at) continue
      names.add(path.slice(prefix.length).split('/')[0] ?? '')
    }
    return Promise.all(
      [...names].sort(compareCodePoints).map((name) => this.row(prefix + name, name)),
    )
  }

  private refused(route: string): Response | null {
    const failure = this.fail.get(route)
    return failure === undefined ? null : json(failure[0], { message: failure[1] })
  }

  private async listing(route: string | null, raw: string, at: string): Promise<Response> {
    if (route !== null) {
      this.log.push([route, raw])
      const refused = this.refused(route)
      if (refused !== null) return refused
    }
    let rows = await this.shallow(at)
    const keep = this.truncatedDirs.get(at)
    if (keep !== undefined) rows = rows.slice(0, keep)
    return json(200, { sha: treeSha(at), tree: rows, truncated: keep !== undefined })
  }

  private async tree(raw: string, recursive: boolean): Promise<Response> {
    const segment = decodeURIComponent(raw)
    if (recursive) {
      this.log.push(['recursive', raw])
      const refused = this.refused('recursive')
      if (refused !== null) return refused
      if (segment !== this.ref) return json(404, { message: 'Not Found' })
      let paths = [...this.files.keys(), ...this.dirs()].sort(compareCodePoints)
      if (this.truncatedRecursive) paths = paths.filter((p) => !p.includes('/'))
      const tree = await Promise.all(paths.map((p) => this.row(p, p)))
      return json(200, { sha: treeSha(''), tree, truncated: this.truncatedRecursive })
    }
    const colon = segment.indexOf(':')
    if (colon >= 0) {
      this.log.push(['dir', raw])
      const refused = this.refused('dir')
      if (refused !== null) return refused
      if (segment.slice(0, colon) !== this.ref) return json(404, { message: 'Not Found' })
      const at = segment.slice(colon + 1).replace(/^\/+|\/+$/g, '')
      const parts = at === '' ? [] : at.split('/')
      for (let depth = 1; depth <= parts.length; depth += 1) {
        if (this.files.has(parts.slice(0, depth).join('/'))) {
          return json(422, {
            message: 'Invalid object requested. SHA must identify a commit or a tree.',
          })
        }
      }
      if (at !== '' && !this.dirs().has(at)) return json(404, { message: 'Not Found' })
      return this.listing(null, raw, at)
    }
    if (segment === this.ref) return this.listing('dir', raw, '')
    const at = [...this.dirs()].find((d) => treeSha(d) === segment)
    if (at === undefined) {
      this.log.push(['sha_dir', raw])
      return json(404, { message: 'Not Found' })
    }
    return this.listing('sha_dir', raw, at)
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
// retry sees real data; a root child would let ensureLiveIndex's root probe
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
    await refillIndex(this.accessor, this, '/gh')
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
    await refillIndex(this.accessor, this, '/gh')
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
