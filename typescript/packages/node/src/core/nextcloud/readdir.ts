import type { FileStat, PathSpec } from '@struktoai/mirage-core/types'
import { enoent, enotdir, listingError } from '@struktoai/mirage-core/errors/fs'
import { mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import { rstripSlash, stripSlash } from '@struktoai/mirage-core/utils/slash'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { SCOPE_ERROR } from './constants.ts'
import { statOf } from './stat.ts'
import { isNotFound } from './util.ts'

// isFile and isDir probes that share one PROPFIND per key: one stat answers
// both, a collection included, so a walk asking each of a component in turn
// sends one request for it rather than two. Mirrors Python's _kind_probes.
function kindProbes(
  accessor: NextcloudAccessor,
): [(key: string) => Promise<boolean>, (key: string) => Promise<boolean>] {
  const kinds = new Map<string, 'file' | 'dir' | null>()
  const kind = async (key: string): Promise<'file' | 'dir' | null> => {
    const stripped = stripSlash(key)
    const known = kinds.get(stripped)
    if (known !== undefined) return known
    const op = await accessor.operator()
    let found: 'file' | 'dir' | null
    try {
      found = (await op.stat(stripped)).isDirectory() ? 'dir' : 'file'
    } catch (error) {
      if (!isNotFound(error)) throw error
      found = null
    }
    kinds.set(stripped, found)
    return found
  }
  return [async (key) => (await kind(key)) === 'file', async (key) => (await kind(key)) === 'dir']
}

/** A folder's children, each as `stat` answers it. Mirrors Python's `readdir`. */
export async function readdir(accessor: NextcloudAccessor, path: PathSpec): Promise<FileStat[]> {
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  let target = path.pattern !== null ? path.directory : path.virtual
  if (prefix !== '' && target.startsWith(prefix)) {
    const rest = target.slice(prefix.length)
    if (prefix.endsWith('/') || rest === '' || rest.startsWith('/')) target = rest || '/'
  }
  const virtualKey = rstripSlash(prefix !== '' ? `${prefix}${target}` : target) || '/'
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
  if (entries.length === 0 && stripped !== '') {
    // PROPFIND on a collection lists the collection itself, so an empty
    // directory still yields one entry and only a path the server does not
    // have yields none. The lister reports that as an empty result rather
    // than raising, so without this `ls /nextcloud/never` rendered an empty
    // directory and exited 0. The mount root is exempt: it exists because
    // it is mounted.
    throw await listingError(path, target, ...kindProbes(accessor))
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
  // PROPFIND normally carries getcontentlength for every file; when the
  // lister omits the metadata, one stat per affected file fills the gap so
  // a listing never answers an unknown size.
  for (const [key, info] of metadata) {
    if (directories.has(key) || info.size !== null) continue
    const md = await op.stat(stripSlash(key))
    info.size = md.contentLength !== null ? Number(md.contentLength) : null
    if (info.modified === '' && md.lastModified !== null) info.modified = md.lastModified
  }
  const targetKey = `/${stripSlash(target)}`
  if (names.length === 1 && names[0] === targetKey && !directories.has(targetKey)) {
    throw enotdir(path)
  }
  names.sort(compareCodePoints)
  if (names.length > SCOPE_ERROR) {
    console.warn(
      `nextcloud readdir: ${virtualKey} returned ${String(names.length)} entries (limit ${String(SCOPE_ERROR)})`,
    )
  }
  return names.map((key) => {
    const info = metadata.get(key)
    const folder = directories.has(key)
    return statOf(
      key.split('/').pop() ?? key,
      folder,
      folder ? null : (info?.size ?? null),
      info?.modified ?? '',
    )
  })
}
