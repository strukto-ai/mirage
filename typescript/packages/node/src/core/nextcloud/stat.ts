import type { Metadata } from 'opendal'
import { IndexEntry, ResourceType } from '@struktoai/mirage-core/cache/index/config'
import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import { FileStat, FileType } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent } from '@struktoai/mirage-core/errors/fs'
import { contentTypeForPath } from '@struktoai/mirage-core/utils/filetype'
import { mountPrefixOf, rawPathOf } from '@struktoai/mirage-core/utils/key_prefix'
import { stripSlash } from '@struktoai/mirage-core/utils/slash'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { searchFiles } from './search/index.ts'
import { isNotFound } from './util.ts'

/** A listed row as `stat` renders it, the same from the index and from a search. */
export function statOf(entry: IndexEntry): FileStat {
  if (entry.resourceType === ResourceType.FOLDER) {
    return new FileStat({
      name: entry.name,
      type: FileType.DIRECTORY,
      modified: entry.remoteTime || null,
    })
  }
  return new FileStat({
    name: entry.name,
    size: entry.size ?? null,
    modified: entry.remoteTime || null,
    type: FileType.FILE,
    content: contentTypeForPath(entry.name),
  })
}

/**
 * Every file and folder under a directory, each as `stat` answers it after a
 * listing, from Nextcloud's file search: a page of a thousand per request,
 * where a walk sends one per folder. Null from a server without the search,
 * for a path it cannot find or that is a file, and when a file comes back
 * without its length, which only a stat of it fills. Mirrors `tree` in
 * `mirage/core/nextcloud/stat.py`.
 */
export async function tree(
  accessor: NextcloudAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
): Promise<Map<string, FileStat> | null> {
  const found = await searchFiles(accessor, path)
  if (found === null) return null
  const base = stripSlash(rawPathOf(path))
  const lead = base === '' ? '/' : `/${base}/`
  const rows = new Map<string, FileStat>()
  for (const entry of found) {
    if (!entry.key.startsWith(lead)) continue
    const folder = entry.kind === 'd'
    if (!folder && entry.size === null) return null
    rows.set(
      entry.key.slice(lead.length),
      statOf(
        new IndexEntry({
          id: entry.key,
          name: entry.key.slice(entry.key.lastIndexOf('/') + 1),
          resourceType: folder ? ResourceType.FOLDER : ResourceType.FILE,
          size: entry.size,
          remoteTime: entry.modified ?? '',
        }),
      ),
    )
  }
  return rows
}

export async function stat(
  accessor: NextcloudAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  const raw = rawPathOf(path)
  const key = stripSlash(raw)
  if (key === '') return new FileStat({ name: '/', type: FileType.DIRECTORY })
  const virtualKey = prefix !== '' ? `${prefix}/${key}` : `/${key}`
  if (index !== undefined) {
    const lookup = await index.get(virtualKey)
    if (lookup.entry !== undefined && lookup.entry !== null) {
      return statOf(lookup.entry)
    }
    const parent = virtualKey.slice(0, virtualKey.lastIndexOf('/')) || '/'
    const listing = await index.listDir(parent)
    if (listing.entries !== undefined && listing.entries !== null) throw enoent(path)
  }
  const op = await accessor.operator()
  let metadata: Metadata
  try {
    metadata = await op.stat(key)
  } catch (error) {
    if (isNotFound(error)) throw enoent(path)
    throw error
  }
  if (!metadata.isDirectory()) return fileStat(key, raw, metadata)
  return new FileStat({
    name: key.split('/').pop() ?? '/',
    type: FileType.DIRECTORY,
    modified: metadata.lastModified,
  })
}

function fileStat(key: string, raw: string, metadata: Metadata): FileStat {
  const etag = metadata.etag
  return new FileStat({
    name: key.split('/').pop() ?? key,
    size: metadata.contentLength !== null ? Number(metadata.contentLength) : null,
    modified: metadata.lastModified,
    type: FileType.FILE,
    content: contentTypeForPath(raw),
    fingerprint: etag,
    extra: etag !== null && etag !== '' ? { etag } : {},
  })
}
