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

import type { SqlAccessor } from '../../accessor/sql.ts'
import { eisdir, enoent, enotdir, listingError } from '../../errors/fs.ts'
import type { FsError } from '../../errors/types.ts'
import type { PathSpec } from '../../types.ts'
import { norm } from '../../utils/path.ts'
import { stripSlash } from '../../utils/slash.ts'
import { INODE_COLUMNS, MAX_COLUMNS, MAX_PARAMS, ROOT_INO } from './constants.ts'
import { byIno, inodeOf, isDir, type Inode, type InoRef } from './inode.ts'

/**
 * A mount path resolved one name at a time from the root. `chain[0]` is the
 * root and `chain[i]` the inode the first `i` names reach, null from the
 * first name the tree does not hold (or that a file stands above). Mirrors
 * Python's `Walk`.
 */
export interface Walk {
  /** The normalized mount path. */
  readonly p: string
  readonly names: readonly string[]
  readonly chain: readonly (Inode | null)[]
}

/** The names a normalized mount path walks from the root. */
export function namesOf(p: string): string[] {
  const bare = stripSlash(p)
  return bare === '' ? [] : bare.split('/')
}

// SQLite joins at most this many tables in one query.
const MAX_JOIN_TABLES = 64

// One query walks as many names as its limits allow: every inode column for
// the start and each name within `MAX_COLUMNS`, two tables a name past the
// start within `MAX_JOIN_TABLES`, one parameter a name within `MAX_PARAMS`.
// The columns bind first, at 19 names. A deeper path walks on from where the
// last query stopped.
const NAMES_PER_QUERY = Math.min(
  Math.floor(MAX_COLUMNS / INODE_COLUMNS.length) - 1,
  Math.floor((MAX_JOIN_TABLES - 1) / 2),
  MAX_PARAMS,
)

// The inode `from` and the inode each of `names` reaches below it in turn,
// null from the first miss, in one query: each level joins the entry under
// the inode above it.
async function walkFrom(
  accessor: SqlAccessor,
  from: number,
  names: readonly string[],
): Promise<(Inode | null)[]> {
  const levels = names.length + 1
  const select: string[] = []
  const joins: string[] = []
  for (let i = 0; i < levels; i++) {
    const at = String(i)
    select.push(...INODE_COLUMNS.map((c) => `n${at}.${c} AS l${at}_${c}`))
    if (i > 0) {
      const up = String(i - 1)
      joins.push(
        `LEFT JOIN fs_dentry d${at} ON d${at}.parent_ino = n${up}.ino AND d${at}.name = ?`,
        `LEFT JOIN fs_inode n${at} ON n${at}.ino = d${at}.ino`,
      )
    }
  }
  const sql = `SELECT ${select.join(', ')} FROM fs_inode n0 ${joins.join(' ')}
    WHERE n0.ino = ${byIno(from).sql}`
  const row = (await accessor.query(sql, names))[0]
  return Array.from({ length: levels }, (_, i) => inodeOf(row, `l${String(i)}_`))
}

/**
 * Resolve `path` from the root, `NAMES_PER_QUERY` names a query, so the
 * database walks every name and answers every inode on the way, and a miss
 * stops the chain where it happens. Mirrors Python's `walk`.
 */
export async function walk(accessor: SqlAccessor, path: PathSpec | string): Promise<Walk> {
  const p = norm(typeof path === 'string' ? path : path.mountPath)
  const names = namesOf(p)
  const chain = await walkFrom(accessor, ROOT_INO, names.slice(0, NAMES_PER_QUERY))
  for (let at = NAMES_PER_QUERY; at < names.length; at += NAMES_PER_QUERY) {
    const part = names.slice(at, at + NAMES_PER_QUERY)
    const last = chain[chain.length - 1] ?? null
    if (last === null) chain.push(...part.map(() => null))
    else chain.push(...(await walkFrom(accessor, last.ino, part)).slice(1))
  }
  return { p, names, chain }
}

/** The inode the whole path reaches, or null. */
export function target(w: Walk): Inode | null {
  return w.chain[w.names.length] ?? null
}

/** The directory that holds the path's last name, or null. */
export function parentOf(w: Walk): Inode | null {
  return w.names.length === 0 ? null : (w.chain[w.names.length - 1] ?? null)
}

/** The parent as a statement names it; the walk must have found it. */
export function parentRef(w: Walk): InoRef {
  return byIno(parentOf(w)?.ino ?? ROOT_INO)
}

/** The path's last name; empty for the root. */
export function leaf(w: Walk): string {
  return w.names[w.names.length - 1] ?? ''
}

// The first error resolving the path's parents meets: a name the tree does
// not hold is ENOENT, a plain file where a directory has to be ENOTDIR, at any
// depth, as open(2) and rename(2) resolve a path.
function brokenParent(w: Walk, spec: PathSpec): FsError | null {
  for (let i = 1; i < w.names.length; i++) {
    const node = w.chain[i]
    if (node === null || node === undefined) return enoent(spec)
    if (!isDir(node)) return enotdir(spec)
  }
  return null
}

/**
 * Refuse a path whose parents are not all directories: every op that makes
 * an entry (write, create, mkdir, rename, copy, truncate) creates none of
 * them, which is `mkdir -p`'s job. Mirrors Python's `check_dest_parents`.
 */
export function checkDestParents(w: Walk, spec: PathSpec): void {
  const broken = brokenParent(w, spec)
  if (broken !== null) throw broken
}

/** Refuse writing bytes to a directory, as open(2) for writing does. */
export function checkWriteTarget(w: Walk, spec: PathSpec): void {
  const node = target(w)
  if (node !== null && isDir(node)) throw eisdir(spec)
}

/**
 * The error a lookup of a path the walk did not reach answers: a plain file
 * above it is ENOTDIR (`cat a.txt/x`), anything else ENOENT. Mirrors Python's
 * `lookup_error`.
 */
export function lookupError(w: Walk, spec: PathSpec): FsError {
  return brokenParent(w, spec) ?? enoent(spec)
}

/** The inode the path names, or the error its lookup answers. */
export function found(w: Walk, spec: PathSpec): Inode {
  const node = target(w)
  if (node === null) throw lookupError(w, spec)
  return node
}

/** The error listing a path that is no directory answers, off the walk. */
export function notListable(w: Walk, spec: PathSpec): Promise<FsError> {
  const at = new Map<string, Inode | null>()
  w.names.forEach((_, i) => at.set(`/${w.names.slice(0, i + 1).join('/')}`, w.chain[i + 1] ?? null))
  const node = (k: string): Inode | null => at.get(k) ?? null
  return listingError(
    spec,
    w.p,
    (k) => {
      const n = node(k)
      return n !== null && !isDir(n)
    },
    (k) => {
      const n = node(k)
      return n !== null && isDir(n)
    },
  )
}
