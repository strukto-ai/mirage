import { enoent, invalidateAfterUnlink, rstripSlash, type PathSpec } from '@struktoai/mirage-core'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { isNotFound, nextcloudKey } from './util.ts'

export async function rmdir(accessor: NextcloudAccessor, path: PathSpec): Promise<void> {
  const key = `${rstripSlash(nextcloudKey(path))}/`
  const op = await accessor.operator()
  try {
    await op.delete(key)
  } catch (error) {
    if (isNotFound(error)) throw enoent(path)
    throw error
  }
  await invalidateAfterUnlink(path)
}
