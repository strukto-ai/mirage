import { type FileStat, type PathSpec } from '@struktoai/mirage-core'
import type { NextcloudAccessor } from '../../../accessor/nextcloud.ts'
import { stat } from '../stat.ts'

export async function statOrNull(
  accessor: NextcloudAccessor,
  path: PathSpec,
): Promise<FileStat | null> {
  try {
    return await stat(accessor, path)
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'ENOENT') return null
    throw error
  }
}
