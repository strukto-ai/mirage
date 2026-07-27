import { FileType, stripSlash, type PathSpec } from '@struktoai/mirage-core'
import type { NextcloudAccessor } from '../../../accessor/nextcloud.ts'
import { isNotFound, rawPathOf } from '../util.ts'
import { statOrNull } from './walk.ts'

export async function size(accessor: NextcloudAccessor, path: PathSpec): Promise<number> {
  const info = await statOrNull(accessor, path)
  if (info !== null && info.type !== FileType.DIRECTORY) return info.size ?? 0
  const prefix = stripSlash(rawPathOf(path))
  const scanPath = prefix !== '' ? `${prefix}/` : '/'
  const op = await accessor.operator()
  let total = 0
  try {
    for (const entry of await op.list(scanPath, { recursive: true })) {
      const metadata = entry.metadata()
      if (entry.path().endsWith('/') || metadata.isDirectory()) continue
      total += metadata.contentLength !== null ? Number(metadata.contentLength) : 0
    }
  } catch (error) {
    if (isNotFound(error)) return 0
    throw error
  }
  return total
}
