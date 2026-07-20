import { enoent, invalidateAfterUnlink, type PathSpec } from '@struktoai/mirage-core'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { isNotFound, nextcloudKey } from './util.ts'

export async function rmR(accessor: NextcloudAccessor, path: PathSpec): Promise<void> {
  const key = `${nextcloudKey(path).replace(/\/+$/, '')}/`
  const op = await accessor.operator()
  try {
    await op.removeAll(key)
  } catch (error) {
    if (isNotFound(error)) throw enoent(path)
    throw error
  }
  await invalidateAfterUnlink(path)
}
