import type { IndexCacheStore, PathSpec } from '@struktoai/mirage-core'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { write } from './write.ts'

export function create(
  accessor: NextcloudAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<void> {
  return write(accessor, path, new Uint8Array(), index)
}
