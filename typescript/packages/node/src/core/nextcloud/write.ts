import {
  enoent,
  invalidateAfterWrite,
  record,
  ResourceName,
  type IndexCacheStore,
  type PathSpec,
} from '@struktoai/mirage-core'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { isNotFound, nextcloudKey } from './util.ts'

export async function write(
  accessor: NextcloudAccessor,
  path: PathSpec,
  data: Uint8Array,
  _index?: IndexCacheStore,
): Promise<void> {
  const startMs = performance.now()
  try {
    const op = await accessor.operator()
    await op.write(nextcloudKey(path), Buffer.from(data))
  } catch (error) {
    if (isNotFound(error)) throw enoent(path)
    throw error
  }
  record('write', path.virtual, ResourceName.NEXTCLOUD, data.byteLength, startMs)
  await invalidateAfterWrite(path)
}
