import type { PathSpec } from '@struktoai/mirage-core/types'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { remove } from './fence.ts'

/**
 * Remove a subtree in one DELETE that the server refuses once anything below
 * has changed since the survey (`remove`): what changed stays, and the call
 * throws ENOTEMPTY. Mirrors Python's `rm_r`.
 */
export async function rmR(accessor: NextcloudAccessor, path: PathSpec): Promise<void> {
  await remove(accessor, path, false)
}
