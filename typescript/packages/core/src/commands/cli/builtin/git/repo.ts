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

import git, { Errors, type CommitObject } from 'isomorphic-git'

import { abbrevLength, FULL_SHA, type CommitFacts } from './format.ts'
import { decodeText } from '../../../../shell/bytes.ts'
import {
  configValues,
  FANOUT_SIZE,
  gitFs,
  IDX_MAGIC,
  packedObject,
  SHA_BYTES,
  V2_HEADER,
  type Packed,
  type Packs,
} from './fs.ts'
import { readNames, readOptional, readRange, writeFile } from './io.ts'
import { entryName } from '../../../../utils/remnants.ts'

import { toHex } from '../../../../utils/hex.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import { gitBool } from './util.ts'
import {
  GITLINK_MODE,
  IDX_SUFFIX,
  OBJECTS_DIR,
  PACK_DIR,
  SHALLOW_FILE,
  TREE_MODE,
} from './constants.ts'
import { GitError } from './errors.ts'
import type { RefObject, RepoLocation, TreeItem } from './types.ts'
import type { Files } from '../../../../workspace/files.ts'

// A v2 pack index is a 8-byte header then 256 fanout entries; the last one is
// the object count, so the total is four bytes at a fixed offset. A v1 index
// has no header and starts with the fanout, its entries an offset and a name
// each rather than names alone.
const FANOUT_END = V2_HEADER + FANOUT_SIZE
const DEC = new TextDecoder()
const V1_OFFSET_BYTES = 4
// One rewrite of each `.git/shallow` at a time, so fetches running side by
// side keep each other's cuts: an update waits for the last one queued on its
// path, and the path is dropped once its queue settles.
const SHALLOW_WRITERS = new Map<string, Promise<void>>()

/**
 * A repository living in a mount, opened for reading.
 *
 * `fs` is the whole bridge: isomorphic-git reaches every byte through it, so its
 * own algorithms (history walk, tree diff, three-way merge) run against a mount
 * without ever learning that one exists. Nothing here is loaded eagerly, which
 * is also what git does.
 *
 * Objects come from the common directory and refs from both: a linked worktree
 * shares the object database and the branches of the repository it was cut from,
 * and owns only HEAD and whatever refs are per-checkout.
 */
export interface Repo {
  readonly fs: ReturnType<typeof gitFs>
  readonly vfs: Files
  /** The object database's packs, the ones `fs` reads for isomorphic-git. */
  readonly packs: Packs | null
  readonly location: RepoLocation
  /** Parsed packs shared by this invocation, never retained across commands. */
  readonly cache: Record<symbol, unknown>
  /** How many hex digits this repository abbreviates an id to. */
  readonly abbrev: number
  /** The commits `.git/shallow` lists, read as parentless (`grafted`). */
  readonly shallow: ReadonlySet<string>
  /** Blobs this invocation hashed from the working tree and never wrote. */
  readonly held: Map<string, Uint8Array>
  /**
   * Where resolving a name two refs answer to puts git's `refname is
   * ambiguous` warning, for the verb to print ahead of its own stderr; null
   * when `core.warnAmbiguousRefs` is off or nothing collects them.
   */
  readonly ambiguous: string[] | null
  /**
   * Where this command found each tree and blob it was shown,
   * repository-relative (`seen.ts`).
   */
  readonly places: Map<string, string>
  /**
   * Whether a hide or a rule could cover anything in the working tree for the
   * running command, once asked (`guarded`); null until then.
   */
  guarded: boolean | null
  /** The place each operand's own path gave the object it names (`placeNamed`). */
  readonly named: Map<string, string>
  /**
   * Blobs this command listed only at places a rule keeps from it, each with
   * the first such place.
   */
  readonly sealed: Map<string, string>
  /** Blobs it listed where it may read them. */
  readonly free: Set<string>
  /** Every place the shared history walk has sighted each object at so far (`seen.ts`). */
  readonly seen: Map<string, string[]>
  /** That walk, resumed by each lookup; null until one starts it. */
  sightings: AsyncGenerator<[string, string], void> | null
}

/** The argument bag every isomorphic-git call in this package shares. */
export function repoArgs(repo: Repo): {
  fs: never
  dir: string
  gitdir: string
  cache: Repo['cache']
} {
  return {
    fs: repo.fs as never,
    dir: repo.location.worktree.virtual,
    gitdir: repo.location.gitdir.virtual,
    cache: repo.cache,
  }
}

/**
 * Every id, loose or packed, starting with a two-digit fanout prefix, sorted.
 * Nothing is read but each pack index's bucket for that byte and the one loose
 * directory, which is what widening abbreviated ids needs: an index's fanout
 * table says where that bucket of its sorted names starts and ends.
 *
 * @param fanout two lowercase hex digits
 */
export async function idsUnder(repo: Repo, fanout: string): Promise<string[]> {
  const found = new Set<string>()
  const byte = parseInt(fanout, 16)
  const root = repo.location.commondir.join(PACK_DIR)
  for (const entry of await readNames(repo.vfs, root)) {
    const name = entryName(entry)
    if (!name.endsWith(IDX_SUFFIX)) continue
    const path = root.join(name)
    const head = await readRange(repo.vfs, path, 0, IDX_MAGIC.length)
    const v2 = IDX_MAGIC.every((value, i) => head[i] === value)
    const fanoutAt = v2 ? FANOUT_END - FANOUT_SIZE : 0
    const bytes = await readRange(repo.vfs, path, fanoutAt, FANOUT_SIZE)
    if (bytes.byteLength < FANOUT_SIZE) continue
    const table = new DataView(bytes.buffer, bytes.byteOffset, FANOUT_SIZE)
    const start = byte === 0 ? 0 : table.getUint32((byte - 1) * 4, false)
    const end = table.getUint32(byte * 4, false)
    if (end <= start) continue
    const stride = v2 ? SHA_BYTES : SHA_BYTES + V1_OFFSET_BYTES
    const names = await readRange(
      repo.vfs,
      path,
      fanoutAt + FANOUT_SIZE + start * stride,
      (end - start) * stride,
    )
    for (let at = v2 ? 0 : V1_OFFSET_BYTES; at + SHA_BYTES <= names.byteLength; at += stride)
      found.add(toHex(names.subarray(at, at + SHA_BYTES)))
  }
  const loose = repo.location.commondir.join(`${OBJECTS_DIR}/${fanout}`)
  for (const entry of await readNames(repo.vfs, loose)) {
    const name = entryName(entry)
    if (fanout.length + name.length === FULL_SHA) found.add(`${fanout}${name}`)
  }
  return [...found].sort(compareCodePoints)
}

/**
 * The one id an abbreviation names, read off the index buckets and loose
 * directory its first two digits fall in (`idsUnder`), as isomorphic-git's
 * expandOid did before packs left its sight (`fs.ts`).
 *
 * @param repo the opened repository
 * @param short the id as typed, at least four hex digits
 * @throws Errors.NotFoundError when no object starts with it, or it is not hex
 * @throws Errors.AmbiguousError when more than one does
 */
export async function expandedId(repo: Repo, short: string): Promise<string> {
  if (!/^[0-9a-f]{2,40}$/.test(short)) throw new Errors.NotFoundError(short)
  const found = (await idsUnder(repo, short.slice(0, 2))).filter((oid) => oid.startsWith(short))
  const [only] = found
  if (only === undefined) throw new Errors.NotFoundError(short)
  if (found.length > 1) throw new Errors.AmbiguousError('oids', short, found)
  return only
}

/**
 * An object's type and its bytes as stored, whichever kind of object it is.
 *
 * Looked for in the packs before the loose objects, as git looks (and
 * Python's VfsObjectStore.get_raw): a packed one is its own entry inflated,
 * with none of the loose file's gitdir check, probe, wrapping and rehash on
 * the way. One no pack holds, or whose entry does not read, is isomorphic-git's
 * to find or word as git does.
 */
export async function rawObject(repo: Repo, oid: string): Promise<RefObject> {
  let found: Packed | null = null
  try {
    found = repo.packs === null ? null : await packedObject(repo.packs, oid)
  } catch (err) {
    console.debug('packed object unreadable:', err)
  }
  if (found !== null) return { oid, type: found.type, raw: found.content }
  // Deprecated upstream for being general, but the general answer is what the
  // callers need: which kind this id names and its stored content, without
  // reading it as each kind in turn until one does not throw.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const read = await git.readObject({ ...repoArgs(repo), oid, format: 'content' })
  return { oid, type: read.type, raw: read.object as Uint8Array }
}

/**
 * The entries of one tree object, read from its stored bytes: each one its
 * mode, a space, its name, a NUL and its 20-byte id.
 *
 * Parsed here rather than through isomorphic-git's readTree, which refuses a
 * whole tree over one entry named `..` or `.git`, a tree git stores and reads
 * and refuses only to write out (`validPath`), and decodes each name as UTF-8,
 * turning a byte that is not into U+FFFD. A name keeps every byte, a byte UTF-8
 * cannot read carried as its surrogate escape, so the name quotes and prints
 * the way git's does. A subtree's `40000` is spelled `040000`, as isomorphic-git
 * spells it.
 */
export async function storedItems(repo: Repo, treeOid: string): Promise<TreeItem[]> {
  const { type, raw } = await rawObject(repo, treeOid)
  if (type !== 'tree') throw new GitError(`unable to read tree (${treeOid})`)
  const items: TreeItem[] = []
  for (let at = 0; at < raw.length;) {
    const space = raw.indexOf(0x20, at)
    const nul = space < 0 ? -1 : raw.indexOf(0x00, space)
    if (nul < 0 || nul + 1 + SHA_BYTES > raw.length)
      throw new GitError(`unable to read tree (${treeOid})`)
    const stored = DEC.decode(raw.subarray(at, space))
    const mode = stored === '40000' ? TREE_MODE : stored
    items.push({
      path: decodeText(raw.subarray(space + 1, nul)),
      oid: toHex(raw.subarray(nul + 1, nul + 1 + SHA_BYTES)),
      mode,
      type: mode === TREE_MODE ? 'tree' : mode === GITLINK_MODE ? 'commit' : 'blob',
    })
    at = nul + 1 + SHA_BYTES
  }
  return items
}

/**
 * The object id a ref resolves to.
 *
 * A chain of symbolic refs that circles resolves to nothing, so it answers as a
 * ref that is not there does, which is how git reads one.
 */
export async function refOid(repo: Repo, ref: string): Promise<string> {
  try {
    return await git.resolveRef({ ...repoArgs(repo), ref })
  } catch (err) {
    if (err instanceof Errors.InternalError && err.data.message.startsWith('Circular reference'))
      throw new Errors.NotFoundError(ref)
    throw err
  }
}

/** Which of commit/tag/tree/blob an id names, null when the repository lacks it. */
export async function objectType(repo: Repo, oid: string): Promise<string | null> {
  try {
    return (await rawObject(repo, oid)).type
  } catch (err) {
    if (err instanceof Errors.NotFoundError) return null
    throw err
  }
}

/** List more commits in `.git/shallow`, one id a line, sorted; none writes nothing. */
export async function addShallow(repo: Repo, oids: readonly string[]): Promise<void> {
  if (!oids.length) return
  const path = repo.location.commondir.join(SHALLOW_FILE)
  const before = SHALLOW_WRITERS.get(path.virtual) ?? Promise.resolve()
  const update = before.then(async () => {
    const held = new TextDecoder()
      .decode((await readOptional(repo.vfs, path)) ?? new Uint8Array())
      .split(/\s+/)
      .filter(Boolean)
    const lines = [...new Set([...held, ...oids])].sort(compareCodePoints)
    await writeFile(
      repo.vfs,
      path,
      new TextEncoder().encode(lines.map((oid) => `${oid}\n`).join('')),
    )
  })
  const settled = update.then(
    () => undefined,
    () => undefined,
  )
  SHALLOW_WRITERS.set(path.virtual, settled)
  try {
    await update
  } finally {
    if (SHALLOW_WRITERS.get(path.virtual) === settled) SHALLOW_WRITERS.delete(path.virtual)
  }
}

/**
 * Open a repository living in a mount.
 *
 * The id abbreviation counts the objects the repository's packs hold, read
 * off each pack index, which states its own count in its fanout table, so
 * this costs one small ranged read per pack. Loose objects are deliberately
 * not counted: git's own estimate ignores them, and matching that is what
 * makes an abbreviated id agree with real git.
 *
 * @param vfs the session's files
 * @param location the discovered repository
 */
export async function openRepo(
  vfs: Files,
  location: RepoLocation,
  ambiguous: string[] | null = null,
): Promise<Repo> {
  const root = location.commondir.join(PACK_DIR)
  let packed = 0
  for (const entry of await readNames(vfs, root)) {
    const name = entryName(entry)
    if (!name.endsWith(IDX_SUFFIX)) continue
    const head = await readRange(vfs, root.join(name), FANOUT_END - 4, 4)
    if (head.byteLength < 4) continue
    packed += new DataView(head.buffer, head.byteOffset, 4).getUint32(0, false)
  }
  const shallow = await readOptional(vfs, location.commondir.join(SHALLOW_FILE))
  const fs = gitFs(vfs, location)
  return {
    fs,
    vfs,
    packs: fs.packs,
    location,
    cache: {},
    abbrev: abbrevLength(packed),
    shallow: new Set(
      new TextDecoder()
        .decode(shallow ?? new Uint8Array())
        .split(/\s+/)
        .filter(Boolean),
    ),
    held: new Map(),
    ambiguous,
    places: new Map(),
    guarded: null,
    named: new Map(),
    sealed: new Map(),
    free: new Set(),
    seen: new Map(),
    sightings: null,
  }
}

/**
 * A blob's bytes, a held one first: what `git diff` hashes from the working
 * tree is rendered like any blob, but git writes none of it. Then the packs,
 * then the loose objects, as git looks. Mirrors Python's VfsObjectStore.hold.
 */
export async function readBlobBytes(repo: Repo, oid: string): Promise<Uint8Array> {
  const held = repo.held.get(oid)
  if (held !== undefined) return held
  const stored = await rawObject(repo, oid)
  // Anything else is git.readBlob's to peel or refuse, as a tag or a tree.
  return stored.type === 'blob' ? stored.raw : (await git.readBlob({ ...repoArgs(repo), oid })).blob
}

/**
 * A commit's parents as git reads them: none for a shallow repository's
 * boundary commit, which git grafts parentless when it parses one, while the
 * raw bytes `cat-file` prints keep their `parent` lines. Mirrors Python's
 * VfsObjectStore graft.
 */
function grafted(repo: Repo, oid: string, parents: readonly string[]): string[] {
  return repo.shallow.has(oid) ? [] : [...parents]
}

/**
 * One commit read through isomorphic-git, its parents as git reads them: every
 * commit read that walks history goes through here, so none follows a parent a
 * shallow repository does not hold.
 */
export async function readCommit(repo: Repo, oid: string): Promise<CommitObject> {
  const { commit } = await git.readCommit({ ...repoArgs(repo), oid })
  return { ...commit, parent: grafted(repo, oid, commit.parent) }
}

/**
 * One commit's metadata and message from a single object read. The message
 * retains its stored newlines; identity offsets are minutes east of UTC.
 */
export async function commitFacts(repo: Repo, oid: string): Promise<CommitFacts> {
  let object = await rawObject(repo, oid)
  while (object.type === 'tag') {
    const target = /^object ([0-9a-f]{40})\n/.exec(new TextDecoder().decode(object.raw))?.[1]
    if (target === undefined) throw new GitError(`invalid tag ${object.oid}`)
    object = await rawObject(repo, target)
  }
  if (object.type !== 'commit') {
    throw new Errors.ObjectTypeError(oid, object.type as 'blob' | 'tree', 'commit')
  }
  const raw = object.raw
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(raw)
  const split = text.indexOf('\n\n')
  const message = split < 0 ? '' : text.slice(split + 2)
  const headers = (split < 0 ? text : text.slice(0, split)).split('\n')
  const value = (key: string): string =>
    headers.find((line) => line.startsWith(`${key} `))?.slice(key.length + 1) ?? ''
  const identity = (role: string) => {
    const found = /^(.*) <(.*)> (-?[0-9]+) ([+-])([0-9]{2})([0-9]{2})$/.exec(value(role))
    if (found === null) throw new GitError(`invalid ${role} in commit ${oid}`)
    const [, name = '', email = '', timestamp = '', sign, hours = '', minutes = ''] = found
    const offset = Number(hours) * 60 + Number(minutes)
    return {
      name,
      email,
      timestamp: Number(timestamp),
      offset: sign === '-' ? -offset : offset,
    }
  }
  const author = identity('author')
  const committer = identity('committer')
  const decoded = [message, author.name, author.email, committer.name, committer.email]
  // A byte that is no part of a character decoded as U+FFFD: the object's own
  // bytes are decoded again, as surrogate-escaped text, for the filters that
  // match them.
  let bytes: CommitFacts['bytes']
  if (decoded.some((text) => text.includes('\uFFFD'))) {
    const text = decodeText(raw)
    const split = text.indexOf('\n\n')
    const head = (split < 0 ? text : text.slice(0, split)).split('\n')
    const ident = (key: string): string =>
      (head.find((line) => line.startsWith(`${key} `)) ?? '')
        .slice(key.length + 1)
        .replace(/ -?\d+ [+-]\d{4}$/, '')
    bytes = {
      message: split < 0 ? '' : text.slice(split + 2),
      author: ident('author'),
      committer: ident('committer'),
    }
  }
  return {
    ...(bytes === undefined ? {} : { bytes }),
    oid,
    tree: value('tree'),
    message,
    authorName: author.name,
    authorEmail: author.email,
    authorTime: author.timestamp,
    authorTimezoneMinutes: author.offset,
    committerName: committer.name,
    committerEmail: committer.email,
    committerTime: committer.timestamp,
    committerTimezoneMinutes: committer.offset,
    parents: grafted(
      repo,
      object.oid,
      headers.filter((line) => line.startsWith('parent ')).map((line) => line.slice(7)),
    ),
  }
}

/**
 * A boolean from the repository's config, read the way git reads one.
 *
 * @param repo the opened repository
 * @param path the variable, e.g. `core.quotepath`
 * @param fallback the answer when the variable is unset
 */
export async function configBool(repo: Repo, path: string, fallback: boolean): Promise<boolean> {
  const values = await configValues(repo.vfs, repo.location, path)
  return gitBool(values, path.toLowerCase(), fallback)
}
