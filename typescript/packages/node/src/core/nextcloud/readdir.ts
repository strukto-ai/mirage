import {
  enotdir,
  enoent,
  IndexEntry,
  mountPrefixOf,
  ResourceType,
  rstripSlash,
  stripSlash,
  type IndexCacheStore,
  type PathSpec,
} from '@struktoai/mirage-core'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { SCOPE_ERROR } from './constants.ts'
import { isNotFound } from './util.ts'

export async function readdir(
  accessor: NextcloudAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  let target = path.pattern !== null ? path.directory : path.virtual
  if (prefix !== '' && target.startsWith(prefix)) {
    const rest = target.slice(prefix.length)
    if (prefix.endsWith('/') || rest === '' || rest.startsWith('/')) target = rest || '/'
  }
  const virtualKey = rstripSlash(prefix !== '' ? `${prefix}${target}` : target) || '/'
  if (index !== undefined) {
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) return listing.entries
  }
  const stripped = stripSlash(target)
  const listPath = stripped !== '' ? `${stripped}/` : '/'
  const op = await accessor.operator()
  let entries
  try {
    entries = await op.list(listPath)
  } catch (error) {
    if (isNotFound(error)) throw enoent(path)
    throw error
  }
  const names: string[] = []
  const directories = new Set<string>()
  const metadata = new Map<string, { size: number | null; modified: string }>()
  for (const entry of entries) {
    const relative = entry.path()
    if (relative === '' || relative === listPath) continue
    const info = entry.metadata()
    const isDirectory = relative.endsWith('/') || info.isDirectory()
    const key = `/${rstripSlash(relative)}`
    names.push(key)
    if (isDirectory) directories.add(key)
    metadata.set(key, {
      size: info.contentLength !== null ? Number(info.contentLength) : null,
      modified: info.lastModified ?? '',
    })
  }
  const targetKey = `/${stripSlash(target)}`
  if (names.length === 1 && names[0] === targetKey && !directories.has(targetKey)) {
    throw enotdir(path)
  }
  names.sort()
  if (names.length > SCOPE_ERROR) {
    console.warn(
      `nextcloud readdir: ${virtualKey} returned ${String(names.length)} entries (limit ${String(SCOPE_ERROR)})`,
    )
  }
  if (index !== undefined) {
    await index.setDir(
      virtualKey,
      names.map((key) => {
        const name = key.split('/').pop() ?? key
        const info = metadata.get(key)
        return [
          name,
          new IndexEntry({
            id: key,
            name,
            resourceType: directories.has(key) ? ResourceType.FOLDER : ResourceType.FILE,
            size: directories.has(key) ? null : (info?.size ?? null),
            remoteTime: info?.modified ?? '',
          }),
        ]
      }),
    )
  }
  return names.map((key) => (prefix !== '' ? `${prefix}${key}` : key)).sort()
}
