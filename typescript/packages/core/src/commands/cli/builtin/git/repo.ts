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

import type { PathSpec } from '../../../../types.ts'
import git, { Errors } from 'isomorphic-git'

import { abbrevLength, type CommitFacts } from './format.ts'
import { decodeText } from '../../../../shell/bytes.ts'
import { configValues, gitFs } from './fs.ts'
import { exists, readNames, readRange, writeFile } from './io.ts'
import { entryName } from '../../../../utils/remnants.ts'

import { toHex } from '../../../../utils/hex.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import { gitBool } from './util.ts'
import { GitError } from './errors.ts'
import type { RefObject, RepoLocation } from './types.ts'
import type { Files } from '../../../../workspace/files.ts'

const PACK_DIR = 'objects/pack'
const IDX_SUFFIX = '.idx'
// A v2 pack index is a 8-byte header then 256 fanout entries; the last one is
// the object count, so the total is four bytes at a fixed offset.
const FANOUT_END = 8 + 256 * 4
const FANOUT_SIZE = 256 * 4
// A v2 index opens with this magic; a v1 one has none and starts with the
// fanout, its entries an offset and a name each rather than names alone.
const IDX_MAGIC = [0xff, 0x74, 0x4f, 0x63]
const SHA_BYTES = 20
const V1_OFFSET_BYTES = 4
const OBJECTS_DIR = 'objects'
const LOOSE_NAME_LENGTH = 38

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
  readonly location: RepoLocation
  /** Parsed packs shared by this invocation, never retained across commands. */
  readonly cache: Record<symbol, unknown>
  /** How many hex digits this repository abbreviates an id to. */
  readonly abbrev: number
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
 * How many objects the repository's packs hold, for the id abbreviation.
 *
 * Read off each pack index, which states its own count in its fanout table, so
 * this costs one small ranged read per pack. Loose objects are deliberately not
 * counted: git's own estimate ignores them, and matching that is what makes an
 * abbreviated id agree with real git.
 */
async function packedCount(vfs: Files, commondir: PathSpec): Promise<number> {
  const root = commondir.join(PACK_DIR)
  let total = 0
  for (const entry of await readNames(vfs, root)) {
    const name = entryName(entry)
    if (!name.endsWith(IDX_SUFFIX)) continue
    const head = await readRange(vfs, root.join(name), FANOUT_END - 4, 4)
    if (head.byteLength < 4) continue
    total += new DataView(head.buffer, head.byteOffset, 4).getUint32(0, false)
  }
  return total
}

/**
 * The ids one pack index holds whose first byte is `byte`: its fanout table
 * says where that bucket of the sorted names starts and ends, so only the
 * bucket is read rather than every name.
 */
async function packedUnder(vfs: Files, path: PathSpec, byte: number): Promise<string[]> {
  const head = await readRange(vfs, path, 0, IDX_MAGIC.length)
  const v2 = IDX_MAGIC.every((value, i) => head[i] === value)
  const fanoutAt = v2 ? FANOUT_END - FANOUT_SIZE : 0
  const fanout = await readRange(vfs, path, fanoutAt, FANOUT_SIZE)
  if (fanout.byteLength < FANOUT_SIZE) return []
  const table = new DataView(fanout.buffer, fanout.byteOffset, FANOUT_SIZE)
  const start = byte === 0 ? 0 : table.getUint32((byte - 1) * 4, false)
  const end = table.getUint32(byte * 4, false)
  if (end <= start) return []
  const stride = v2 ? SHA_BYTES : SHA_BYTES + V1_OFFSET_BYTES
  const skip = v2 ? 0 : V1_OFFSET_BYTES
  const names = await readRange(
    vfs,
    path,
    fanoutAt + FANOUT_SIZE + start * stride,
    (end - start) * stride,
  )
  const ids: string[] = []
  for (let at = skip; at + SHA_BYTES <= names.byteLength; at += stride)
    ids.push(toHex(names.subarray(at, at + SHA_BYTES)))
  return ids
}

/**
 * Every id, loose or packed, starting with a two-digit fanout prefix, sorted.
 * Nothing is read but each pack index's bucket for that byte and the one loose
 * directory, which is what widening abbreviated ids needs.
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
    for (const oid of await packedUnder(repo.vfs, root.join(name), byte)) found.add(oid)
  }
  const loose = repo.location.commondir.join(`${OBJECTS_DIR}/${fanout}`)
  for (const entry of await readNames(repo.vfs, loose)) {
    const name = entryName(entry)
    if (name.length === LOOSE_NAME_LENGTH) found.add(`${fanout}${name}`)
  }
  return [...found].sort(compareCodePoints)
}

/** An object's type and its bytes as stored, whichever kind of object it is. */
export async function rawObject(repo: Repo, oid: string): Promise<RefObject> {
  // Deprecated upstream for being general, but the general answer is what the
  // callers need: which kind this id names and its stored content, without
  // reading it as each kind in turn until one does not throw.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const read = await git.readObject({ ...repoArgs(repo), oid, format: 'content' })
  return { oid, type: read.type, raw: read.object as Uint8Array }
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

/**
 * Keep a fetched pack whole, beside the index git reads it through.
 *
 * Named by the pack's own checksum, as git names one it receives, and indexed
 * after the pack is written, so a reader that lists `.idx` files never finds
 * one whose pack is not there yet. An empty pack stores nothing.
 */
export async function storePack(repo: Repo, data: Uint8Array): Promise<void> {
  if (!data.length) return
  const checksum = toHex(data.subarray(data.length - 20))
  const dir = repo.location.commondir.join(PACK_DIR)
  const name = `pack-${checksum}.pack`
  if (await exists(repo.vfs, dir.join(name.replace(/\.pack$/, IDX_SUFFIX)))) return
  await writeFile(repo.vfs, dir.join(name), data)
  await git.indexPack({ ...repoArgs(repo), dir: dir.virtual, filepath: name })
}

/**
 * Open a repository living in a mount.
 *
 * @param vfs the session's files
 * @param location the discovered repository
 */
export async function openRepo(
  vfs: Files,
  location: RepoLocation,
  ambiguous: string[] | null = null,
): Promise<Repo> {
  return {
    fs: gitFs(vfs, location),
    vfs,
    location,
    cache: {},
    abbrev: abbrevLength(await packedCount(vfs, location.commondir)),
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
 * tree is rendered like any blob, but git writes none of it. Mirrors
 * Python's VfsObjectStore.hold.
 */
export async function readBlobBytes(repo: Repo, oid: string): Promise<Uint8Array> {
  return repo.held.get(oid) ?? (await git.readBlob({ ...repoArgs(repo), oid })).blob
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
    parents: headers.filter((line) => line.startsWith('parent ')).map((line) => line.slice(7)),
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
