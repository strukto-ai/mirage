import type { Operator } from 'opendal'
import { invalidateAfterWrite, invalidateAncestors } from '@struktoai/mirage-core/cache/context'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { eexist, enotdir } from '@struktoai/mirage-core/utils/errors'
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
 * Create a collection; opendal creates missing parents either way.
 *
 * `parents` is accepted for the op signature and ignored, because
 * `createDir` is MKCOL over every missing level whatever it says. That is
 * also why the ancestor invalidation is unconditional: a bare `mkdir a/b/c`
 * materializes a whole chain here, and gating the walk on `parents` (as the
 * backends whose mkdir really does create one level correctly do) left every
 * ancestor above the parent serving a cached listing that hid the new levels
 * until the index TTL expired.
 */
export async function mkdir(
  accessor: NextcloudAccessor,
  path: PathSpec,
  _parents = false,
): Promise<void> {
  const key = rstripSlash(nextcloudKey(path))
  const op = await accessor.operator()
  // MKCOL under a file is a 409 opendal leaves unnamed, and opendal reads
  // MKCOL's 405 on a taken name as done, a file holding the name included:
  // look the levels up to tell ENOTDIR from EEXIST.
  try {
    await op.createDir(`${key}/`)
  } catch (error) {
    const level = await fileLevel(op, key)
    if (level === null) throw error
    throw level === key ? eexist(path) : enotdir(path)
  }
  let taken = false
  try {
    taken = !(await op.stat(key)).isDirectory()
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  if (taken) throw eexist(path)
  await invalidateAfterWrite(path)
  await invalidateAncestors(path)
}
