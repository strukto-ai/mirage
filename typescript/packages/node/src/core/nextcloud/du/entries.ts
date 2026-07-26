import { FileType, lstripSlash, stripSlash, type PathSpec } from '@struktoai/mirage-core'
import type { NextcloudAccessor } from '../../../accessor/nextcloud.ts'
import { isNotFound, rawPathOf } from '../util.ts'
import { statOrNull } from './walk.ts'

export async function entries(
  accessor: NextcloudAccessor,
  path: PathSpec,
): Promise<[[string, number][], number]> {
  const info = await statOrNull(accessor, path)
  if (info !== null && info.type !== FileType.DIRECTORY) return [[], info.size ?? 0]
  const prefix = stripSlash(rawPathOf(path))
  const scanPath = prefix !== '' ? `${prefix}/` : '/'
  const op = await accessor.operator()
  const found: [string, number][] = []
  let total = 0
  try {
    for (const entry of await op.list(scanPath, { recursive: true })) {
      const key = entry.path()
      const metadata = entry.metadata()
      if (key === '' || key.endsWith('/') || metadata.isDirectory()) continue
      const size = metadata.contentLength !== null ? Number(metadata.contentLength) : 0
      found.push([`/${lstripSlash(key)}`, size])
      total += size
    }
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  found.sort(([left], [right]) => left.localeCompare(right))
  return [found, total]
}
