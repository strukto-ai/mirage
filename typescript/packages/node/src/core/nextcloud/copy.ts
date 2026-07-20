import { enoent, invalidateAfterWrite, type PathSpec } from '@struktoai/mirage-core'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { isNotFound, nextcloudKey } from './util.ts'

export async function copy(
  accessor: NextcloudAccessor,
  source: PathSpec,
  destination: PathSpec,
): Promise<void> {
  const op = await accessor.operator()
  try {
    await op.copy(nextcloudKey(source), nextcloudKey(destination))
  } catch (error) {
    if (isNotFound(error)) throw enoent(source)
    throw error
  }
  await invalidateAfterWrite(destination)
}
