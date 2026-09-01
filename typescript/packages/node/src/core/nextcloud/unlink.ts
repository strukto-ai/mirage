import { invalidateAfterUnlink } from '@struktoai/mirage-core/cache/context'
import { record, startOp } from '@struktoai/mirage-core/observe/context'
import { ResourceName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent } from '@struktoai/mirage-core/utils/errors'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { isNotFound, nextcloudKey } from './util.ts'

export async function unlink(accessor: NextcloudAccessor, path: PathSpec): Promise<void> {
  const op = await accessor.operator()
  const timer = startOp()
  try {
    await op.delete(nextcloudKey(path))
  } catch (error) {
    if (isNotFound(error)) throw enoent(path)
    throw error
  }
  record('unlink', path.virtual, ResourceName.NEXTCLOUD, 0, timer)
  await invalidateAfterUnlink(path)
}
