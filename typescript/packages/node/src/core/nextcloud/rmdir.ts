import type { PathSpec } from '@struktoai/mirage-core/types'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { remove } from './rm.ts'

/**
 * Remove an empty collection, refusing one that holds a child or gains one
 * before the DELETE lands (`remove`). Mirrors Python's `rmdir`.
 */
export async function rmdir(accessor: NextcloudAccessor, path: PathSpec): Promise<void> {
  await remove(accessor, path, true)
}
