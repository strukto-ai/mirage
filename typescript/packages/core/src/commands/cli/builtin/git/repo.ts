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
import git from 'isomorphic-git'

import { abbrevLength, type CommitFacts } from './format.ts'
import { configValues, gitFs } from './fs.ts'
import { exists, readNames, readRange, writeFile } from './io.ts'
import { entryName } from '../../../../utils/remnants.ts'

import { compareCodePoints } from '../../../../utils/sort.ts'
import { gitBool } from './util.ts'
import type { Dispatch, RepoLocation } from './types.ts'

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
  readonly dispatch: Dispatch
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
async function packedCount(dispatch: Dispatch, commondir: PathSpec): Promise<number> {
  const root = commondir.join(PACK_DIR)
  let total = 0
  for (const entry of await readNames(dispatch, root)) {
    const name = entryName(entry)
    if (!name.endsWith(IDX_SUFFIX)) continue
    const head = await readRange(dispatch, root.join(name), FANOUT_END - 4, 4)
    if (head.byteLength < 4) continue
    total += new DataView(head.buffer, head.byteOffset, 4).getUint32(0, false)
  }
  return total
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * The ids one pack index holds whose first byte is `byte`: its fanout table
 * says where that bucket of the sorted names starts and ends, so only the
 * bucket is read rather than every name.
 */
async function packedUnder(dispatch: Dispatch, path: PathSpec, byte: number): Promise<string[]> {
  const head = await readRange(dispatch, path, 0, IDX_MAGIC.length)
  const v2 = IDX_MAGIC.every((value, i) => head[i] === value)
  const fanoutAt = v2 ? FANOUT_END - FANOUT_SIZE : 0
  const fanout = await readRange(dispatch, path, fanoutAt, FANOUT_SIZE)
  if (fanout.byteLength < FANOUT_SIZE) return []
  const table = new DataView(fanout.buffer, fanout.byteOffset, FANOUT_SIZE)
  const start = byte === 0 ? 0 : table.getUint32((byte - 1) * 4, false)
  const end = table.getUint32(byte * 4, false)
  if (end <= start) return []
  const stride = v2 ? SHA_BYTES : SHA_BYTES + V1_OFFSET_BYTES
  const skip = v2 ? 0 : V1_OFFSET_BYTES
  const names = await readRange(
    dispatch,
    path,
    fanoutAt + FANOUT_SIZE + start * stride,
    (end - start) * stride,
  )
  const ids: string[] = []
  for (let at = skip; at + SHA_BYTES <= names.byteLength; at += stride)
    ids.push(hex(names.subarray(at, at + SHA_BYTES)))
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
  for (const entry of await readNames(repo.dispatch, root)) {
    const name = entryName(entry)
    if (!name.endsWith(IDX_SUFFIX)) continue
    for (const oid of await packedUnder(repo.dispatch, root.join(name), byte)) found.add(oid)
  }
  const loose = repo.location.commondir.join(`${OBJECTS_DIR}/${fanout}`)
  for (const entry of await readNames(repo.dispatch, loose)) {
    const name = entryName(entry)
    if (name.length === LOOSE_NAME_LENGTH) found.add(`${fanout}${name}`)
  }
  return [...found].sort(compareCodePoints)
}

/** Which of commit/tag/tree/blob an id names, null when the repository lacks it. */
export async function objectType(repo: Repo, oid: string): Promise<string | null> {
  try {
    // Deprecated upstream for being general, but the general answer is what a
    // walk needs: which kind this id names, without reading it as each in turn
    // until one does not throw.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    return (await git.readObject({ ...repoArgs(repo), oid, format: 'content' })).type
  } catch {
    return null
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
  const checksum = [...data.subarray(data.length - 20)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  const dir = repo.location.commondir.join(PACK_DIR)
  const name = `pack-${checksum}.pack`
  if (await exists(repo.dispatch, dir.join(name.replace(/\.pack$/, IDX_SUFFIX)))) return
  await writeFile(repo.dispatch, dir.join(name), data)
  await git.indexPack({ ...repoArgs(repo), dir: dir.virtual, filepath: name })
}

/**
 * Open a repository living in a mount.
 *
 * @param dispatch workspace op dispatcher
 * @param location the discovered repository
 */
export async function openRepo(
  dispatch: Dispatch,
  location: RepoLocation,
  ambiguous: string[] | null = null,
): Promise<Repo> {
  return {
    fs: gitFs(dispatch, location),
    dispatch,
    location,
    cache: {},
    abbrev: abbrevLength(await packedCount(dispatch, location.commondir)),
    held: new Map(),
    ambiguous,
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
 * One commit as the renderers want it.
 *
 * isomorphic-git reports the timezone the way `Date.getTimezoneOffset()` does,
 * negated minutes east of UTC, so `+0530` arrives as `-330`. git prints the
 * other sign, and this is the one place the two conventions meet.
 */
export async function commitFacts(repo: Repo, oid: string): Promise<CommitFacts> {
  const { commit } = await git.readCommit({ ...repoArgs(repo), oid })
  return {
    oid,
    tree: commit.tree,
    message: commit.message,
    authorName: commit.author.name,
    authorEmail: commit.author.email,
    authorTime: commit.author.timestamp,
    authorTimezoneMinutes: -commit.author.timezoneOffset,
    committerName: commit.committer.name,
    committerEmail: commit.committer.email,
    committerTime: commit.committer.timestamp,
    committerTimezoneMinutes: -commit.committer.timezoneOffset,
    parents: commit.parent,
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
  const values = await configValues(repo.dispatch, repo.location, path)
  return gitBool(values, path.toLowerCase(), fallback)
}
