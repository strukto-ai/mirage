import type { Operator } from 'opendal'
import { invalidateAfterWrite, invalidateAncestors } from '@struktoai/mirage-core/cache/context'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { eexist, enoent, enotdir } from '@struktoai/mirage-core/utils/errors'
import { mountedPath } from '@struktoai/mirage-core/utils/key_prefix'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { isNotFound, nextcloudKey } from './util.ts'

// The first level of `key` that is a file, null when none is. Mirrors
// Python's `_file_level`.
async function fileLevel(op: Operator, key: string): Promise<string | null> {
  let level = ''
  for (const part of key.split('/')) {
    level = level === '' ? part : `${level}/${part}`
    try {
      if (!(await op.stat(level)).isDirectory()) return level
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }
  return null
}

/**
 * Create a collection.
 *
 * opendal's `createDir` is MKCOL over every missing level, so a bare mkdir
 * looks its parent up first and refuses a missing one, as mkdir(2) does; only
 * `-p` materializes a chain, and only it walks the ancestor listings. With
 * `parents`, a file in the way is named rather than the operand.
 */
export async function mkdir(
  accessor: NextcloudAccessor,
  path: PathSpec,
  parents = false,
): Promise<void> {
  const key = rstripSlash(nextcloudKey(path))
  const op = await accessor.operator()
  const parent = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : ''
  if (!parents && parent !== '') {
    let isDir: boolean
    try {
      isDir = (await op.stat(parent)).isDirectory()
    } catch (error) {
      if (!isNotFound(error)) throw error
      throw (await fileLevel(op, parent)) === null ? enoent(path) : enotdir(path)
    }
    if (!isDir) throw enotdir(path)
  }
  // MKCOL under a file is a 409 opendal leaves unnamed, and opendal reads
  // MKCOL's 405 on a taken name as done, a file holding the name included:
  // look the levels up to tell ENOTDIR from EEXIST.
  try {
    await op.createDir(`${key}/`)
  } catch (error) {
    const level = await fileLevel(op, key)
    if (level === null) throw error
    if (level === key) throw eexist(path)
    // mkdir(2) blames the operand; the walk `-p` makes stops at the file and
    // names it.
    throw enotdir(parents ? mountedPath(path, `/${level}`) : path)
  }
  await invalidateAfterWrite(path)
  if (parents) await invalidateAncestors(path)
  let taken = false
  try {
    taken = !(await op.stat(key)).isDirectory()
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  if (taken) throw eexist(path)
}
