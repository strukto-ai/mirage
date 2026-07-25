import {
  invalidateAfterWrite,
  invalidateAncestors,
  rstripSlash,
  type PathSpec,
} from '@struktoai/mirage-core'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { nextcloudKey } from './util.ts'

export async function mkdir(
  accessor: NextcloudAccessor,
  path: PathSpec,
  parents = false,
): Promise<void> {
  const key = `${rstripSlash(nextcloudKey(path))}/`
  const op = await accessor.operator()
  await op.createDir(key)
  await invalidateAfterWrite(path)
  if (parents) await invalidateAncestors(path)
}
