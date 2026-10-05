import type { Operator } from 'opendal'
import { invalidateAfterWrite, invalidateAncestors } from '@struktoai/mirage-core/cache/context'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { eexist, enotdir } from '@struktoai/mirage-core/utils/errors'
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
 * Create a collection; opendal creates missing parents either way.
 *
 * `parents` only picks the path a refusal names, because `createDir` is
 * MKCOL over every missing level whatever it says. That is
 * also why the ancestor invalidation is unconditional: a bare `mkdir a/b/c`
 * materializes a whole chain here, and gating the walk on `parents` (as the
 * backends whose mkdir really does create one level correctly do) left every
 * ancestor above the parent serving a cached listing that hid the new levels
 * until the index TTL expired.
 */
export async function mkdir(
  accessor: NextcloudAccessor,
  path: PathSpec,
  parents = false,
): Promise<void> {
  const key = rstripSlash(nextcloudKey(path))
  const op = await accessor.operator()
  // MKCOL under a file is a 409 opendal leaves unnamed: look the levels up
  // to tell ENOTDIR from EEXIST. Its 405 on a taken name reads as done, so a
  // taken name is the doors' to refuse (refuseTaken).
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
  await invalidateAncestors(path)
}
