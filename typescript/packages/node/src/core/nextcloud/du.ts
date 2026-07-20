import { FileType, type FileStat, type PathSpec } from '@struktoai/mirage-core'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { stat } from './stat.ts'
import { isNotFound, rawPathOf } from './util.ts'

async function statOrNull(accessor: NextcloudAccessor, path: PathSpec): Promise<FileStat | null> {
  try {
    return await stat(accessor, path)
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'ENOENT') return null
    throw error
  }
}

export async function du(accessor: NextcloudAccessor, path: PathSpec): Promise<number> {
  const info = await statOrNull(accessor, path)
  if (info !== null && info.type !== FileType.DIRECTORY) return info.size ?? 0
  const prefix = rawPathOf(path).replace(/^\/+|\/+$/g, '')
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

export async function duAll(
  accessor: NextcloudAccessor,
  path: PathSpec,
): Promise<[[string, number][], number]> {
  const info = await statOrNull(accessor, path)
  if (info !== null && info.type !== FileType.DIRECTORY) return [[], info.size ?? 0]
  const raw = rawPathOf(path)
  const prefix = raw.replace(/^\/+|\/+$/g, '')
  const scanPath = prefix !== '' ? `${prefix}/` : '/'
  const op = await accessor.operator()
  const entries: [string, number][] = []
  let total = 0
  try {
    for (const entry of await op.list(scanPath, { recursive: true })) {
      const key = entry.path()
      const metadata = entry.metadata()
      if (key === '' || key.endsWith('/') || metadata.isDirectory()) continue
      const size = metadata.contentLength !== null ? Number(metadata.contentLength) : 0
      entries.push([`/${key.replace(/^\/+/, '')}`, size])
      total += size
    }
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  entries.sort(([left], [right]) => left.localeCompare(right))
  return [entries, total]
}
