import { invalidateAfterUnlink } from '@struktoai/mirage-core/cache/context'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent, enotempty } from '@struktoai/mirage-core/utils/errors'
import { rstripSlash, stripSlash } from '@struktoai/mirage-core/utils/slash'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { isNotFound, nextcloudKey } from './util.ts'

/**
 * Remove an empty collection.
 *
 * WebDAV DELETE on a collection is recursive (RFC 4918 9.6.1), so this is
 * the same request `rmR` sends and the emptiness check is the only thing
 * separating them. Without it `rmdir` destroyed the whole subtree for
 * every caller that does not pre-check emptiness itself, and the command
 * builders are the only callers that do: FUSE, `ws.fs` and the sandbox
 * runtimes all reach the op directly.
 *
 * PROPFIND on a collection returns the collection itself, so an entry
 * naming the collection is not a child -- the same self-entry rule
 * `readdir` documents.
 */
export async function rmdir(accessor: NextcloudAccessor, path: PathSpec): Promise<void> {
  const key = `${rstripSlash(nextcloudKey(path))}/`
  const stem = stripSlash(key)
  const op = await accessor.operator()
  let hasChild = false
  try {
    const entries = await op.list(key)
    hasChild = entries.some((entry) => stripSlash(entry.path()) !== stem)
    if (!hasChild) await op.delete(key)
  } catch (error) {
    if (isNotFound(error)) throw enoent(path)
    throw error
  }
  if (hasChild) throw enotempty(path)
  await invalidateAfterUnlink(path)
}
