import type { Metadata } from 'opendal'
import { FileStat, FileType } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent } from '@struktoai/mirage-core/errors/fs'
import { contentTypeForPath } from '@struktoai/mirage-core/utils/filetype'
import { rawPathOf } from '@struktoai/mirage-core/utils/key_prefix'
import { stripSlash } from '@struktoai/mirage-core/utils/slash'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { searchFiles } from './search/index.ts'
import { isNotFound } from './util.ts'

/**
 * A listed row as `stat` renders it, the same from a listing and from a
 * search. Mirrors Python's `stat_of`.
 */
export function statOf(
  name: string,
  folder: boolean,
  size: number | null,
  modified: string,
): FileStat {
  if (folder) {
    return new FileStat({ name, type: FileType.DIRECTORY, modified: modified || null })
  }
  return new FileStat({
    name,
    size,
    modified: modified || null,
    type: FileType.FILE,
    content: contentTypeForPath(name),
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
        entry.key.slice(entry.key.lastIndexOf('/') + 1),
        folder,
        entry.size,
        entry.modified ?? '',
      ),
    )
  }
  return rows
}

/** What is at `path`, asked by its WebDAV path. Mirrors Python's `stat`. */
export async function stat(accessor: NextcloudAccessor, path: PathSpec): Promise<FileStat> {
  const raw = rawPathOf(path)
  const key = stripSlash(raw)
  if (key === '') return new FileStat({ name: '/', type: FileType.DIRECTORY })
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
