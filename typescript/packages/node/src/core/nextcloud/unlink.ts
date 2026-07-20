import {
  enoent,
  invalidateAfterUnlink,
  record,
  ResourceName,
  type PathSpec,
} from '@struktoai/mirage-core'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { isNotFound, nextcloudKey } from './util.ts'

export async function unlink(accessor: NextcloudAccessor, path: PathSpec): Promise<void> {
  const op = await accessor.operator()
  const startMs = performance.now()
  try {
    await op.delete(nextcloudKey(path))
  } catch (error) {
    if (isNotFound(error)) throw enoent(path)
    throw error
  }
  record('unlink', path.virtual, ResourceName.NEXTCLOUD, 0, startMs)
  await invalidateAfterUnlink(path)
}
