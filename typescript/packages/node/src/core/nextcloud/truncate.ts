import { invalidateAfterWrite, type PathSpec } from '@struktoai/mirage-core'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { isNotFound, nextcloudKey } from './util.ts'

export async function truncate(
  accessor: NextcloudAccessor,
  path: PathSpec,
  length: number,
): Promise<void> {
  const op = await accessor.operator()
  const key = nextcloudKey(path)
  let current: Buffer
  try {
    current = await op.read(key)
  } catch (error) {
    if (!isNotFound(error)) throw error
    current = Buffer.alloc(0)
  }
  const next = Buffer.alloc(length)
  current.copy(next, 0, 0, Math.min(current.byteLength, length))
  await op.write(key, next)
  await invalidateAfterWrite(path)
}
