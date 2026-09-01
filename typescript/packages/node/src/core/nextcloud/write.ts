import { invalidateAfterWrite } from '@struktoai/mirage-core/cache/context'
import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import { record, startOp } from '@struktoai/mirage-core/observe/context'
import { ResourceName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent } from '@struktoai/mirage-core/utils/errors'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { isNotFound, nextcloudKey } from './util.ts'

export async function write(
  accessor: NextcloudAccessor,
  path: PathSpec,
  data: Uint8Array,
  _index?: IndexCacheStore,
): Promise<void> {
  const timer = startOp()
  try {
    const op = await accessor.operator()
    await op.write(nextcloudKey(path), Buffer.from(data))
  } catch (error) {
    if (isNotFound(error)) throw enoent(path)
    throw error
  }
  record('write', path.virtual, ResourceName.NEXTCLOUD, data.byteLength, timer)
  await invalidateAfterWrite(path)
}
