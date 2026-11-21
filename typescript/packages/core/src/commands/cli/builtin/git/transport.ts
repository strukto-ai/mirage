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

import { statOf } from './io.ts'
import { PathSpec } from '../../../../types.ts'

import git, { Errors } from 'isomorphic-git'

import { HttpConnectError } from '../../../builtin/errors.ts'
import { httpRequest } from '../../../builtin/utils/http.ts'
import { materialize, type ByteSource } from '../../../../io/types.ts'
import { chunks } from '../../../../io/cooperative.ts'
import { closeQuietly } from '../../../../io/stream.ts'
import { Digest } from '../../../../utils/hash.ts'
import { fromHex } from '../../../../utils/hex.ts'
import type { Context } from '../../../config.ts'
import { GITLINK_MODE } from './constants.ts'
import { discover } from './discover.ts'
import { GitError, MissingRepositoryError } from './errors.ts'
import { requireVfs } from './util.ts'
import { loadRefs, readHead, SYMREF_PREFIX } from './refs.ts'
import {
  rawObject,
  readCommit,
  objectType,
  openRepo,
  refOid,
  repoArgs,
  storedItems,
  type Repo,
} from './repo.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import { concat } from '../../../../utils/bytes.ts'
import { rstripSlash } from '../../../../utils/slash.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const FLUSH = '0000'
const SERVICE = 'git-upload-pack'
// What mirage asks an upload-pack for: no progress chatter, packs carried on
// the side band so an error can interrupt them, offset deltas, and the
// annotated tags that point into what is sent. Never thin-pack: a thin pack
// names bases outside itself, which a stored pack cannot hold.
const CAPABILITIES = 'side-band-64k ofs-delta include-tag no-progress agent=git/mirage'
const USER_AGENT = 'git/mirage'
const PACK_BAND = 1
const ERROR_BAND = 3
const REMOTE_HELPER = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//
const SCP_LIKE = /^[^/:]+:/
// The places git tries for a local repository path, in the order it prefers
// them.
const REPO_SUFFIXES = ['/.git', '', '.git/.git', '.git']
const SYMREF_HEAD = 'symref=HEAD:'
export const PEELED = '^{}'
const SHALLOW_LINE = 'shallow '

/** What a remote publishes before anything is fetched. */
export interface Advertisement {
  /** Every ref name and the object id it holds, `HEAD` included. */
  readonly refs: Map<string, string>
  /** The commit each annotated tag peels to. */
  readonly peeled: Map<string, string>
  /** The ref HEAD points at, null when detached or unsaid. */
  readonly head: string | null
  /** Every symbolic ref and its target, for a remote that says. */
  readonly symrefs?: ReadonlyMap<string, string>
}

/** What one fetch brought back. */
export interface Fetched {
  /** The packfile as it arrives, nothing for none. */
  readonly pack: AsyncIterable<Uint8Array>
  /** The commits whose parents were left out, for `.git/shallow`. */
  readonly shallow: readonly string[]
}

/** A remote a fetch or clone reads from. */
export interface Transport {
  advertise(): Promise<Advertisement>
  /**
   * `has` says whether the receiver already holds an object; `depth` is how
   * many commits deep to fetch, null for the whole history; `shallow` lists
   * the receiver's shallow commits.
   */
  fetchPack(
    wants: readonly string[],
    haves: readonly string[],
    has: (oid: string) => Promise<boolean>,
    depth?: number | null,
    shallow?: readonly string[],
  ): Promise<Fetched>
}

/** One pkt-line: four hex digits of length, then the payload. */
export function pktLine(data: Uint8Array | string): Uint8Array {
  const bytes = typeof data === 'string' ? ENC.encode(data) : data
  const out = new Uint8Array(bytes.length + 4)
  out.set(ENC.encode((bytes.length + 4).toString(16).padStart(4, '0')))
  out.set(bytes, 4)
  return out
}

/** Split a pkt-line stream, yielding null for each flush. */
export function* pktLines(data: Uint8Array): Generator<Uint8Array | null> {
  let at = 0
  while (at < data.length) {
    const head = DEC.decode(data.subarray(at, at + 4))
    if (!/^[0-9a-fA-F]{4}$/.test(head))
      throw new GitError(`protocol error: bad line length character: ${head}`)
    const size = parseInt(head, 16)
    if (size === 0) {
      yield null
      at += 4
      continue
    }
    yield data.subarray(at + 4, at + size)
    at += size
  }
}

/**
 * Split a pkt-line stream as it arrives, yielding null for each flush; only
 * the line being read is held.
 */
export async function* pktStream(body: ByteSource): AsyncGenerator<Uint8Array | null> {
  let held: Uint8Array = new Uint8Array(0)
  for await (const chunk of chunks(body)) {
    held = held.length ? concat([held, chunk]) : chunk
    let at = 0
    while (held.length - at >= 4) {
      const head = DEC.decode(held.subarray(at, at + 4))
      if (!/^[0-9a-fA-F]{4}$/.test(head))
        throw new GitError(`protocol error: bad line length character: ${head}`)
      const size = parseInt(head, 16)
      if (size === 0) {
        yield null
        at += 4
        continue
      }
      if (held.length - at < size) break
      yield held.subarray(at + 4, at + size)
      at += size
    }
    held = held.subarray(at)
  }
  if (held.length) throw new GitError('the remote end hung up unexpectedly')
}

/** zlib's deflate of `data`. */
async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** A pack with nothing in it, as a fetch that needs nothing gets. */
function nothing(): AsyncIterable<Uint8Array> {
  return chunks(new Uint8Array())
}

/**
 * A pack of `oids` as git's pack-objects writes one without deltas: each
 * object read and compressed in turn, so only one is held, then the checksum
 * of every byte before it.
 */
async function* packChunks(repo: Repo, oids: readonly string[]): AsyncGenerator<Uint8Array> {
  const kinds: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 }
  const sum = new Digest('sha1')
  try {
    const header = new Uint8Array(12)
    header.set(ENC.encode('PACK'))
    const view = new DataView(header.buffer)
    view.setUint32(4, 2, false)
    view.setUint32(8, oids.length, false)
    sum.update(header)
    yield header
    for (const oid of oids) {
      const { type, raw } = await rawObject(repo, oid)
      let size = raw.byteLength
      const head = [((kinds[type] ?? 0) << 4) | (size & 15)]
      size = Math.floor(size / 16)
      while (size > 0) {
        head[head.length - 1] = (head[head.length - 1] ?? 0) | 0x80
        head.push(size & 0x7f)
        size = Math.floor(size / 128)
      }
      const entry = concat([Uint8Array.from(head), await deflate(raw)])
      sum.update(entry)
      yield entry
    }
    yield fromHex(sum.digest())
  } finally {
    sum.close()
  }
}

/** Read a protocol v0 ref advertisement. */
export function parseAdvertisement(lines: Iterable<Uint8Array | null>): Advertisement {
  const refs = new Map<string, string>()
  const peeled = new Map<string, string>()
  let head: string | null = null
  for (const line of lines) {
    if (line === null) continue
    let text = DEC.decode(line).replace(/\n$/, '')
    const nul = text.indexOf('\0')
    if (nul >= 0) {
      for (const cap of text.slice(nul + 1).split(' '))
        if (cap.startsWith(SYMREF_HEAD)) head = cap.slice(SYMREF_HEAD.length)
      text = text.slice(0, nul)
    }
    const space = text.indexOf(' ')
    const oid = text.slice(0, space)
    const name = text.slice(space + 1)
    if (name === 'capabilities^{}') continue
    if (name.endsWith(PEELED)) peeled.set(name.slice(0, -PEELED.length), oid)
    else refs.set(name, oid)
  }
  return { refs, peeled, head }
}

/** A remote's URL as git prints it: no credentials, no `.git`. */
export function displayUrl(url: string): string {
  let shown = url
  const scheme = REMOTE_HELPER.exec(url)
  if (scheme) {
    const rest = url.slice(scheme[0].length)
    const slash = rest.indexOf('/')
    const host = slash < 0 ? rest : rest.slice(0, slash)
    if (host.includes('@'))
      shown =
        scheme[0] + host.slice(host.lastIndexOf('@') + 1) + (slash < 0 ? '' : rest.slice(slash))
  }
  shown = rstripSlash(shown)
  return shown.endsWith('.git') && shown.length > 4 ? shown.slice(0, -4) : shown
}

/**
 * Every object reachable from `wants` that the other side lacks, and the
 * commits a depth cut shallow.
 *
 * Commits the other side has stop the walk; the trees of those boundary commits
 * are what it already holds, so their contents are left out as upload-pack's
 * edge does. Gitlinks name another repository and are never followed. A depth
 * keeps only the commits that many steps from a want, the want counting as one,
 * walked breadth first so each commit is counted at its nearest, a tag's target
 * at the tag's own step; one at the limit that has parents is cut there,
 * shallow, as `deepen` cuts it. A commit the sender itself holds shallow is cut
 * there too, so a clone of a shallow repository is shallow where it is.
 */
export async function missingObjects(
  repo: Repo,
  wants: readonly string[],
  has: (oid: string) => Promise<boolean>,
  depth: number | null = null,
): Promise<[string[], string[]]> {
  const sending: string[] = []
  const boundary: string[] = []
  const shallow: string[] = []
  const trees: string[] = []
  const seen = new Set<string>()
  const queue: [string, number][] = wants.map((want) => [want, 1])
  // Breadth first reads from a cursor rather than shifting, so the walk stays
  // linear; a tag's target takes the slot the tag was just read from.
  let head = 0
  const take = (): [string, number] | undefined =>
    depth === null ? queue.pop() : head < queue.length ? queue[head++] : undefined
  const now = (item: [string, number]): void => {
    if (depth === null) queue.push(item)
    else queue[--head] = item
  }
  for (let next = take(); next !== undefined; next = take()) {
    const [oid, level] = next
    if (seen.has(oid)) continue
    seen.add(oid)
    if (await has(oid)) {
      boundary.push(oid)
      continue
    }
    const type = await objectType(repo, oid)
    sending.push(oid)
    if (type === 'tag') now([(await git.readTag({ ...repoArgs(repo), oid })).tag.object, level])
    else if (type === 'commit') {
      const commit = await readCommit(repo, oid)
      trees.push(commit.tree)
      if (repo.shallow.has(oid) || (depth !== null && level >= depth && commit.parent.length > 0))
        shallow.push(oid)
      else for (const item of commit.parent) queue.push([item, level + 1])
    }
  }
  const held = new Set<string>()
  for (const oid of boundary) {
    if ((await objectType(repo, oid)) !== 'commit') continue
    const commit = await readCommit(repo, oid)
    await walkTree(repo, commit.tree, held, null)
  }
  for (const tree of trees) await walkTree(repo, tree, held, sending)
  return [sending, shallow]
}

/** Visit a tree once, collecting what is new into `sending`. */
async function walkTree(
  repo: Repo,
  tree: string,
  held: Set<string>,
  sending: string[] | null,
): Promise<void> {
  const stack = [tree]
  for (let oid = stack.pop(); oid !== undefined; oid = stack.pop()) {
    if (held.has(oid)) continue
    held.add(oid)
    sending?.push(oid)
    for (const entry of await storedItems(repo, oid)) {
      if (entry.mode === GITLINK_MODE || held.has(entry.oid)) continue
      if (entry.type === 'tree') stack.push(entry.oid)
      else {
        held.add(entry.oid)
        sending?.push(entry.oid)
      }
    }
  }
}

/** A repository inside the workspace, read through the dispatcher. */
export class LocalTransport implements Transport {
  constructor(
    private readonly repo: Repo,
    private readonly head: string | null,
  ) {}

  /** The source's refs, as upload-pack would advertise them. */
  async advertise(): Promise<Advertisement> {
    const loaded = await loadRefs(
      this.repo.vfs,
      this.repo.location.gitdir,
      this.repo.location.commondir,
    )
    const refs = new Map<string, string>()
    const peeled = new Map<string, string>()
    const symrefs = new Map<string, string>()
    const names = [
      'HEAD',
      ...[...loaded.keys()].filter((name) => name.startsWith('refs/')).sort(compareCodePoints),
    ]
    for (const name of names) {
      let oid: string
      try {
        oid = await refOid(this.repo, name)
      } catch (err) {
        // A symref to an unborn branch names nothing yet.
        if (err instanceof Errors.NotFoundError) continue
        throw err
      }
      refs.set(name, oid)
      const raw = loaded.get(name) ?? ''
      if (raw.startsWith(SYMREF_PREFIX)) symrefs.set(name, raw.slice(SYMREF_PREFIX.length))
      let target = oid
      while ((await objectType(this.repo, target)) === 'tag')
        target = (await git.readTag({ ...repoArgs(this.repo), oid: target })).tag.object
      if (target !== oid) peeled.set(name, target)
    }
    return { refs, peeled, head: this.head, symrefs }
  }

  /** A pack of everything reachable from `wants` the receiver lacks. */
  async fetchPack(
    wants: readonly string[],
    _haves: readonly string[],
    has: (oid: string) => Promise<boolean>,
    depth: number | null = null,
  ): Promise<Fetched> {
    const [oids, shallow] = await missingObjects(this.repo, wants, has, depth)
    return { pack: oids.length ? packChunks(this.repo, oids) : nothing(), shallow }
  }
}

/**
 * A remote reached over git's smart HTTP protocol, version 0.
 *
 * The credentials a URL carried belong to its origin: when the first request
 * is redirected to another one they are dropped, as git reads credentials again
 * from the URL it was sent to. Configured headers go with every request, which
 * is what git does with `http.extraHeader`.
 */
export class HttpTransport implements Transport {
  private url: string
  private readonly headers: Record<string, string>
  private credentials: Record<string, string>
  private readonly configured: boolean

  /**
   * @param url the repository URL, credentials stripped
   * @param headers extra headers for every request
   * @param credentials the Authorization header the URL's userinfo spelled,
   *   empty for none
   */
  constructor(url: string, headers: Record<string, string>, credentials: Record<string, string>) {
    this.url = rstripSlash(url)
    this.headers = { 'User-Agent': USER_AGENT, ...headers }
    this.credentials = credentials
    this.configured = 'Authorization' in headers
  }

  private async request(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: Uint8Array | undefined,
  ): Promise<ByteSource> {
    let resp
    try {
      resp = await httpRequest(url, {
        method,
        headers: { ...this.headers, ...this.credentials, ...headers },
        ...(body === undefined ? {} : { body }),
        timeoutMs: null,
        followRedirects: true,
        stream: true,
      })
    } catch (err) {
      if (err instanceof HttpConnectError)
        throw new GitError(`unable to access '${this.url}/': ${err.message}`)
      throw err
    }
    try {
      if (resp.status === 401 || resp.status === 403) {
        if (this.configured || Object.keys(this.credentials).length)
          throw new GitError(`Authentication failed for '${this.url}/'`)
        const host = new URL(this.url).origin
        throw new GitError(`could not read Username for '${host}': terminal prompts disabled`)
      }
      if (resp.status === 404) throw new GitError(`repository '${this.url}/' not found`)
      if (resp.status >= 400)
        throw new GitError(
          `unable to access '${this.url}/': The requested URL returned error: ${String(resp.status)}`,
        )
    } catch (err) {
      await closeQuietly(resp.body)
      throw err
    }
    if (method === 'GET') {
      const moved = resp.url.split('/info/refs')[0] ?? this.url
      if (new URL(moved).origin !== new URL(this.url).origin) this.credentials = {}
      this.url = moved
    }
    return resp.body
  }

  /** GET `info/refs` for upload-pack and read what it lists. */
  async advertise(): Promise<Advertisement> {
    const body = await materialize(
      await this.request(`${this.url}/info/refs?service=${SERVICE}`, 'GET', {}, undefined),
    )
    const lines = pktLines(body)
    const first = lines.next()
    if (
      first.done === true ||
      first.value === null ||
      DEC.decode(first.value).replace(/\n$/, '') !== `# service=${SERVICE}`
    )
      throw new GitError(`repository '${this.url}/' is not a smart HTTP git server`)
    return parseAdvertisement(lines)
  }

  /**
   * POST the wants and haves to upload-pack; return the pack as it arrives.
   * A shallow receiver names its shallow commits, so the server does not
   * count what lies past them as held, and a depth sends `deepen`; both ask
   * for the `shallow` capability, and the server names each commit it cut in
   * a `shallow` line ahead of the pack, which is read before this returns.
   */
  async fetchPack(
    wants: readonly string[],
    haves: readonly string[],
    _has?: (oid: string) => Promise<boolean>,
    depth: number | null = null,
    shallow: readonly string[] = [],
  ): Promise<Fetched> {
    const [first, ...rest] = wants
    if (first === undefined) return { pack: nothing(), shallow: [] }
    const caps = depth === null && !shallow.length ? CAPABILITIES : `${CAPABILITIES} shallow`
    const parts = [
      pktLine(`want ${first} ${caps}\n`),
      ...rest.map((want) => pktLine(`want ${want}\n`)),
      ...shallow.map((oid) => pktLine(`shallow ${oid}\n`)),
      ...(depth === null ? [] : [pktLine(`deepen ${String(depth)}\n`)]),
      ENC.encode(FLUSH),
      ...haves.map((have) => pktLine(`have ${have}\n`)),
      pktLine('done\n'),
    ]
    const reply = await this.request(
      `${this.url}/${SERVICE}`,
      'POST',
      {
        'Content-Type': `application/x-${SERVICE}-request`,
        Accept: `application/x-${SERVICE}-result`,
      },
      concat(parts),
    )
    const lines = pktStream(reply)
    const cut: string[] = []
    // The pack's first bytes, the line that ended the preamble; null when the
    // reply ends with no pack.
    const payload = async (): Promise<Uint8Array | null> => {
      for (let next = await lines.next(); next.done !== true; next = await lines.next()) {
        const line = next.value
        if (line === null) continue
        const text = DEC.decode(line.subarray(0, 4))
        if (text.startsWith('NAK') || text === 'ACK ') continue
        if (DEC.decode(line.subarray(0, SHALLOW_LINE.length)) === SHALLOW_LINE) {
          cut.push(DEC.decode(line.subarray(SHALLOW_LINE.length)).trim())
          continue
        }
        if (line[0] === PACK_BAND) return line.subarray(1)
        if (line[0] === ERROR_BAND)
          throw new GitError(`remote error: ${DEC.decode(line.subarray(1)).trim()}`)
      }
      return null
    }
    let head: Uint8Array | null
    try {
      head = await payload()
    } catch (err) {
      await lines.return(undefined)
      throw err
    }
    if (head === null) {
      await lines.return(undefined)
      return { pack: nothing(), shallow: cut }
    }
    const opening: Uint8Array = head
    async function* pack(): AsyncGenerator<Uint8Array> {
      try {
        yield opening
        for (let more = await payload(); more !== null; more = await payload()) yield more
      } finally {
        await lines.return(undefined)
      }
    }
    return { pack: pack(), shallow: cut }
  }
}

/** Split userinfo out of a URL into a basic Authorization header. */
function credentials(url: string): [string, Record<string, string>] {
  const scheme = REMOTE_HELPER.exec(url)
  if (!scheme) return [url, {}]
  const rest = url.slice(scheme[0].length)
  const slash = rest.indexOf('/')
  const host = slash < 0 ? rest : rest.slice(0, slash)
  const at = host.lastIndexOf('@')
  if (at < 0) return [url, {}]
  const userinfo = decodeURIComponent(host.slice(0, at))
  const bare = scheme[0] + host.slice(at + 1) + (slash < 0 ? '' : rest.slice(slash))
  const token = btoa(String.fromCharCode(...ENC.encode(userinfo)))
  return [bare, { Authorization: `Basic ${token}` }]
}

/** `http.extraHeader` values as a header table, later ones winning. */
export function extraHeaders(values: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const value of values) {
    const colon = value.indexOf(':')
    const name = (colon < 0 ? value : value.slice(0, colon)).trim()
    const text = colon < 0 ? '' : value.slice(colon + 1).trim()
    if (name && text) headers[name] = text
  }
  return headers
}

/**
 * The transport a remote URL or workspace path names.
 *
 * `https://` and `http://` speak smart HTTP; a path, or a `file://` URL, is a
 * repository inside the workspace reached through the dispatcher. Anything
 * else names a remote helper mirage does not have, which git words the same
 * way. `scoped` is an Authorization for the URL's origin when it carries no
 * userinfo, dropped with it on a redirect elsewhere.
 */
export async function openTransport(
  ctx: Context,
  url: string,
  start: PathSpec,
  headers: Record<string, string>,
  scoped: Readonly<Record<string, string>> = {},
): Promise<Transport> {
  const scheme = REMOTE_HELPER.exec(url)
  const helper = scheme?.[1] ?? null
  if (helper === 'http' || helper === 'https') {
    const [bare, auth] = credentials(url)
    return new HttpTransport(bare, headers, Object.keys(auth).length > 0 ? auth : { ...scoped })
  }
  if (helper !== null && helper !== 'file')
    throw new GitError(`Unable to find remote helper for '${helper}'`)
  if (helper === null && SCP_LIKE.test(url))
    throw new GitError("Unable to find remote helper for 'ssh'")
  const vfs = requireVfs(ctx)
  const raw = helper === null ? url : decodeURIComponent(new URL(url).pathname)
  const path = PathSpec.fromStrPath(raw, undefined, start)
  for (const suffix of REPO_SUFFIXES) {
    const candidate = PathSpec.fromStrPath(
      rstripSlash(path.dotted ?? path.virtual) + suffix,
      undefined,
      '/',
    )
    if ((await statOf(vfs, candidate)) === null) continue
    let location
    try {
      location = await discover(vfs, candidate.parent, candidate)
    } catch (err) {
      if (err instanceof GitError) continue
      throw err
    }
    const head = await readHead(vfs, location.gitdir)
    return new LocalTransport(await openRepo(vfs, location), head.ref)
  }
  throw new MissingRepositoryError(url)
}

/** Whether a remote names a path rather than a URL. */
export function isLocal(url: string): boolean {
  return !REMOTE_HELPER.test(url) && !SCP_LIKE.test(url)
}
