import { invalidateSubtree } from '@struktoai/mirage-core/cache/context'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent } from '@struktoai/mirage-core/errors/fs'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { isNotFound, nextcloudKey } from './util.ts'

export async function rmR(accessor: NextcloudAccessor, path: PathSpec): Promise<void> {
  const key = `${rstripSlash(nextcloudKey(path))}/`
  const op = await accessor.operator()
  try {
    await op.removeAll(key)
  } catch (error) {
    if (isNotFound(error)) throw enoent(path)
    throw error
  }
  await invalidateSubtree(path)
}
