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

import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { contentTypeForPath } from '../../utils/filetype.ts'
import type { TreeEntry } from './driver.ts'
import type { Accessor } from '../../accessor/base.ts'
import { listingError } from '../../errors/fs.ts'
import * as kp from '../../utils/key_prefix.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { ObjectStoreDriver, ReaddirFn, TreeFn } from './driver.ts'

async function probeFile<A extends Accessor, C>(
  driver: ObjectStoreDriver<A, C>,
  conn: C,
  kpfx: string,
  key: string,
): Promise<boolean> {
  return (await driver.head(conn, kp.apply(kpfx, key))) !== null
}

async function probeDir<A extends Accessor, C>(
  driver: ObjectStoreDriver<A, C>,
  conn: C,
  kpfx: string,
  key: string,
): Promise<boolean> {
  return driver.probePrefix(conn, kp.applyDir(kpfx, key))
}

/** Build a prefix listing over one driver. Mirrors Python's `make_readdir`. */
export function makeReaddir<A extends Accessor, C>(driver: ObjectStoreDriver<A, C>): ReaddirFn<A> {
  return async function readdir(accessor, path) {
    const prefix = mountPrefixOf(path.virtual, path.vfsPath)
    // When called from resolveGlob with a pattern (e.g. *.txt), use
    // path.directory for the listing. Direct callers (ls, ops) pass
    // pattern=null so path.virtual is used.
    const virtual = path.pattern !== null ? path.directory : path.virtual
    const rawPath =
      prefix !== '' && virtual.startsWith(prefix) ? virtual.slice(prefix.length) || '/' : virtual
    const kpfx = driver.keyPrefixOf(accessor)
    const pfx = kp.applyDir(kpfx, rawPath)
    const names: string[] = []
    const dirKeys = new Set<string>()
    const sizes = new Map<string, number | null>()
    const times = new Map<string, string>()
    let sawKey = false
    const { conn, close } = await driver.connect(accessor)
    try {
      for await (const child of driver.listChildren(conn, pfx)) {
        sawKey = true
        if (child.kind === 'marker') continue
        const key = '/' + kp.strip(kpfx, child.key)
        if (child.kind === 'd') {
          if (dirKeys.has(key)) continue
          names.push(key)
          dirKeys.add(key)
        } else {
          names.push(key)
          sizes.set(key, child.size ?? null)
          times.set(key, child.modified ?? '')
        }
      }
      if (!sawKey && rstripSlash(rawPath) !== '') {
        // An empty directory is a zero-byte marker object keyed at the
        // prefix itself, so a prefix holding no key at all -- not even that
        // marker -- is a path the store does not have. Without this, `ls`
        // on a missing path rendered an empty directory and exited 0 where
        // every real filesystem reports ENOENT. The mount root is exempt:
        // it exists because it is mounted.
        throw await listingError(
          path,
          rawPath,
          (p) => probeFile(driver, conn, kpfx, p),
          (p) => probeDir(driver, conn, kpfx, p),
        )
      }
    } finally {
      await close()
    }
    const unique = [...new Set(names)].sort(compareCodePoints)
    if (unique.length > driver.scopeError) {
      console.warn(
        `${driver.vfs} readdir: ${path.virtual} returned ` +
          `${String(unique.length)} entries (limit ${String(driver.scopeError)})`,
      )
    }
    return unique.map((key) => {
      const name = key.slice(key.lastIndexOf('/') + 1)
      // Store "folders" are synthetic prefixes with no object of their own,
      // so there is no mtime or size to record. A name that is a key and a
      // prefix both lists as the directory, as a walk enters it.
      if (dirKeys.has(key)) return new FileStat({ name, type: FileType.DIRECTORY })
      const modified = times.get(key) ?? ''
      return new FileStat({
        name,
        size: sizes.get(key) ?? null,
        modified: modified !== '' ? modified : null,
        type: FileType.FILE,
        content: contentTypeForPath(name),
      })
    })
  }
}

/**
 * Every key at and under a path, in one recursive listing: the key at the path
 * itself and every key under it, as `listSubtree` gives them, markers
 * included. Mirrors Python's `read_tree`.
 */
export async function readTree<A extends Accessor, C>(
  driver: ObjectStoreDriver<A, C>,
  accessor: A,
  path: PathSpec,
): Promise<TreeEntry[]> {
  const stem = rstripSlash(kp.apply(driver.keyPrefixOf(accessor), path.mountPath))
  const { conn, close } = await driver.connect(accessor)
  const entries: TreeEntry[] = []
  try {
    for await (const entry of driver.listSubtree(conn, stem)) entries.push(entry)
  } finally {
    await close()
  }
  return entries
}

/**
 * Build `readTree` over one driver: one recursive listing, and the directory
 * itself under `''`. A file stats as a listing gives it (its size, time and
 * content type); a directory, a marker or a key prefix alike, carries nothing but its name. A
 * marker for `path` itself names no entry. Null, so the walk's readdir and
 * stat answer instead, when nothing is under the prefix, when a row has no
 * size, when a key has an empty segment, and when one name is both a file and
 * a prefix, which a readdir lists as a directory. Mirrors Python's
 * `make_tree`.
 */
export function makeTree<A extends Accessor, C>(driver: ObjectStoreDriver<A, C>): TreeFn<A> {
  return async (accessor, path) => {
    const rows = await readTree(driver, accessor, path)
    const prefix = kp.applyDir(driver.keyPrefixOf(accessor), path.mountPath)
    if (!rows.some((row) => row.key.startsWith(prefix))) return null
    const found = new Map<string, FileStat>()
    const dirs = new Set<string>()
    for (const row of rows) {
      if (!row.key.startsWith(prefix)) continue
      const raw = row.key.slice(prefix.length)
      const isDir = raw.endsWith('/')
      const rel = rstripSlash(raw)
      if (rel === '') continue
      const parts = rel.split('/')
      if (parts.includes('') || (!isDir && (row.size ?? null) === null)) return null
      for (let depth = 1; depth < parts.length; depth++) dirs.add(parts.slice(0, depth).join('/'))
      if (isDir) {
        dirs.add(rel)
        continue
      }
      const name = parts[parts.length - 1] ?? rel
      found.set(
        rel,
        new FileStat({
          name,
          size: row.size ?? null,
          modified: row.modified !== undefined && row.modified !== '' ? row.modified : null,
          type: FileType.FILE,
          content: contentTypeForPath(name),
        }),
      )
    }
    for (const rel of dirs) {
      if (found.has(rel)) return null
      found.set(
        rel,
        new FileStat({ name: rel.slice(rel.lastIndexOf('/') + 1), type: FileType.DIRECTORY }),
      )
    }
    const own = rstripSlash(path.mountPath)
    found.set(
      '',
      new FileStat({ name: own.slice(own.lastIndexOf('/') + 1) || '/', type: FileType.DIRECTORY }),
    )
    return found
  }
}
