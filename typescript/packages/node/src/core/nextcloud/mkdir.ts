import { invalidateAfterWrite, type PathSpec } from '@struktoai/mirage-core'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { nextcloudKey } from './util.ts'

export async function mkdir(accessor: NextcloudAccessor, path: PathSpec): Promise<void> {
  const key = `${nextcloudKey(path).replace(/\/+$/, '')}/`
  const op = await accessor.operator()
  await op.createDir(key)
  await invalidateAfterWrite(path)
}
