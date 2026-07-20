import type { Metadata } from 'opendal'
import {
  enoent,
  FileStat,
  FileType,
  guessType,
  mountPrefixOf,
  ResourceType,
  type IndexCacheStore,
  type PathSpec,
} from '@struktoai/mirage-core'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { isNotFound, rawPathOf } from './util.ts'

export async function stat(
  accessor: NextcloudAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const raw = rawPathOf(path)
  const key = raw.replace(/^\/+|\/+$/g, '')
  if (key === '') return new FileStat({ name: '/', type: FileType.DIRECTORY })
  const virtualKey = prefix !== '' ? `${prefix}/${key}` : `/${key}`
  if (index !== undefined) {
    const lookup = await index.get(virtualKey)
    if (lookup.entry !== undefined && lookup.entry !== null) {
      const entry = lookup.entry
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
        type: guessType(entry.name),
      })
    }
    const parent = virtualKey.slice(0, virtualKey.lastIndexOf('/')) || '/'
    const listing = await index.listDir(parent)
    if (listing.entries !== undefined && listing.entries !== null) throw enoent(path)
  }
  const op = await accessor.operator()
  let metadata: Metadata | null = null
  try {
    metadata = await op.stat(key)
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  if (metadata !== null && !metadata.isDirectory()) return fileStat(key, raw, metadata)
  try {
    const directory = await op.stat(`${key}/`)
    if (directory.isDirectory()) {
      return new FileStat({
        name: key.split('/').pop() ?? '/',
        type: FileType.DIRECTORY,
        modified: directory.lastModified,
      })
    }
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  throw enoent(path)
}

function fileStat(key: string, raw: string, metadata: Metadata): FileStat {
  const etag = metadata.etag
  return new FileStat({
    name: key.split('/').pop() ?? key,
    size: metadata.contentLength !== null ? Number(metadata.contentLength) : null,
    modified: metadata.lastModified,
    type: guessType(raw),
    fingerprint: etag,
    extra: etag !== null && etag !== '' ? { etag } : {},
  })
}
