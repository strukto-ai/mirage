import type { PathSpec } from '@struktoai/mirage-core'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { stat } from './stat.ts'

export async function exists(accessor: NextcloudAccessor, path: PathSpec): Promise<boolean> {
  try {
    await stat(accessor, path)
    return true
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'ENOENT') return false
    throw error
  }
}
