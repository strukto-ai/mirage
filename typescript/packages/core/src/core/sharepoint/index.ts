// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import type { ResolvedSharePointPath, SharePointAccessor } from '../../accessor/sharepoint.ts'
import {
  invalidateAfterUnlink,
  invalidateAfterWrite,
  invalidateAncestors,
  invalidateSubtree,
} from '../../cache/context.ts'
import { IndexEntry, ResourceType } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import {
  emitStartPath,
  keep,
  optionsTree,
  startBasename,
  type FindEntry,
  type PredNode,
} from '../../commands/builtin/find_eval.ts'
import { record, startOp } from '../../observe/context.ts'
import type { FindOptions } from '../../resource/base.ts'
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { enoent, enotempty } from '../../utils/errors.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { stripSlash } from '../../utils/slash.ts'
import { GraphError, graphDelete } from '../msgraph/client.ts'
import {
  copyTree,
  createChildFolder,
  driveRootEmpty,
  duTreeEntries,
  duTreeTotal,
  findItems,
  makeExists,
  makeTruncate,
  readItem,
  readdirItems,
  renameReplace,
  statItem,
  streamItem,
  writeItem,
} from '../msgraph/drive.ts'
import { compareCodePoints } from '../../utils/sort.ts'

function directoryPath(path: PathSpec): PathSpec {
  return path.pattern !== null ? path.dir : path
}

function virtualKey(path: PathSpec): string {
  const target = directoryPath(path)
  const prefix = mountPrefixOf(target.virtual, target.resourcePath)
  return target.resourcePath !== ''
    ? `${prefix}/${target.resourcePath}`
    : prefix !== ''
      ? prefix
      : '/'
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

function baseName(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? path : path.slice(index + 1)
}

function requireItem(path: PathSpec, resolved: ResolvedSharePointPath): void {
  if (resolved.driveId === null || resolved.itemPath === null) throw enoent(path)
}

async function resolvedItem(
  accessor: SharePointAccessor,
  path: PathSpec,
): Promise<ResolvedSharePointPath> {
  const resolved = await accessor.resolve(path.resourcePath)
  requireItem(path, resolved)
  return resolved
}

/**
 * Read a file, optionally only a byte range of it.
 *
 * Args:
 *   accessor: SharePoint accessor.
 *   path: the path to read.
 *   _index: unused; Graph resolves the item from the path itself.
 *   options: `{offset, size}`, the byte window, or absent for the whole file.
 */
export async function read(
  accessor: SharePointAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
  options?: { offset?: number; size?: number },
): Promise<Uint8Array> {
  const resolved = await resolvedItem(accessor, path)
  return readItem(
    accessor.config,
    accessor.loc(resolved, path.resourcePath),
    path.virtual,
    path.resourcePath,
    'sharepoint',
    options?.offset ?? 0,
    options?.size ?? null,
  )
}

export async function* stream(
  accessor: SharePointAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  const resolved = await resolvedItem(accessor, path)
  yield* streamItem(
    accessor.config,
    accessor.loc(resolved, path.resourcePath),
    path.virtual,
    path.resourcePath,
    'sharepoint',
  )
}

async function cacheNamespace(
  names: string[],
  storageKey: string,
  relativeKey: string,
  prefix: string,
  index?: IndexCacheStore,
): Promise<string[]> {
  const base = relativeKey === '' || relativeKey === '/' ? '' : relativeKey
  if (index !== undefined) {
    await index.setDir(
      storageKey,
      names.map((name) => [
        name,
        new IndexEntry({
          id: `${base}/${name}`,
          name,
          resourceType: ResourceType.FOLDER,
        }),
      ]),
    )
  }
  return names.map((name) => `${prefix}${base}/${name}`).sort(compareCodePoints)
}

export async function readdir(
  accessor: SharePointAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const target = directoryPath(path)
  const key = virtualKey(path)
  if (index !== undefined) {
    const cached = await index.listDir(key)
    if (cached.entries !== undefined && cached.entries !== null) return cached.entries
  }
  const resolved = await accessor.resolve(target.resourcePath)
  const prefix = mountPrefixOf(target.virtual, target.resourcePath)
  if (resolved.level === 'root') {
    return cacheNamespace(await accessor.listSites(), key, '', prefix, index)
  }
  if (resolved.level === 'site' && resolved.siteId !== null) {
    return cacheNamespace(
      await accessor.listDrives(resolved.siteId),
      key,
      `/${target.resourcePath}`,
      prefix,
      index,
    )
  }
  if (resolved.driveId === null) return []
  return readdirItems(
    accessor.config,
    accessor.loc(resolved, target.resourcePath),
    index,
    prefix,
    target.resourcePath,
    key,
    target,
  )
}

export async function stat(
  accessor: SharePointAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  if (path.resourcePath === '') return new FileStat({ name: '/', type: FileType.DIRECTORY })
  const resolved = await accessor.resolve(path.resourcePath)
  if (resolved.level === 'site') {
    if (resolved.siteId === null) throw enoent(path)
    return new FileStat({ name: path.resourcePath, type: FileType.DIRECTORY })
  }
  if (resolved.level === 'drive') {
    if (resolved.driveId === null) throw enoent(path)
    return new FileStat({ name: baseName(path.resourcePath), type: FileType.DIRECTORY })
  }
  requireItem(path, resolved)
  return statItem(
    accessor.config,
    accessor.loc(resolved, path.resourcePath),
    path,
    virtualKey(path),
    index,
  )
}

export async function write(
  accessor: SharePointAccessor,
  path: PathSpec,
  data: Uint8Array,
): Promise<void> {
  const resolved = await resolvedItem(accessor, path)
  const timer = startOp()
  await writeItem(accessor.config, accessor.loc(resolved, path.resourcePath), data)
  record('write', path.resourcePath, 'sharepoint', data.length, timer)
  await invalidateAfterWrite(path)
}

export async function create(accessor: SharePointAccessor, path: PathSpec): Promise<void> {
  await write(accessor, path, new Uint8Array())
}

async function createDir(
  accessor: SharePointAccessor,
  driveId: string,
  path: string,
): Promise<void> {
  const parent = parentPath(path)
  const resolved: ResolvedSharePointPath = {
    level: parent === '' ? 'drive' : 'item',
    siteId: null,
    driveId,
    itemPath: parent || null,
  }
  await createChildFolder(
    accessor.config,
    accessor.loc(resolved, parent).item('/children'),
    baseName(path),
  )
}

export async function mkdir(
  accessor: SharePointAccessor,
  path: PathSpec,
  parents = false,
): Promise<void> {
  if (path.resourcePath === '') return
  const resolved = await resolvedItem(accessor, path)
  const itemPath = resolved.itemPath ?? ''
  if (parents) {
    const parts = itemPath.split('/')
    for (let index = 1; index <= parts.length; index++) {
      await createDir(accessor, resolved.driveId ?? '', parts.slice(0, index).join('/'))
    }
  } else {
    await createDir(accessor, resolved.driveId ?? '', itemPath)
  }
  await invalidateAfterWrite(path)
  if (parents) await invalidateAncestors(path)
}

export async function unlink(accessor: SharePointAccessor, path: PathSpec): Promise<void> {
  const resolved = await resolvedItem(accessor, path)
  try {
    await graphDelete(accessor.config, accessor.loc(resolved, path.resourcePath).item())
  } catch (error) {
    if (error instanceof GraphError && error.status === 404) throw enoent(path)
    throw error
  }
  await invalidateAfterUnlink(path)
}

export async function rmR(accessor: SharePointAccessor, path: PathSpec): Promise<void> {
  if (path.resourcePath === '') return
  const resolved = await accessor.resolve(path.resourcePath)
  if (resolved.driveId === null || resolved.itemPath === null) return
  await graphDelete(accessor.config, accessor.loc(resolved, path.resourcePath).item())
  await invalidateSubtree(path)
}

/**
 * Remove an empty folder.
 *
 * A Graph `DELETE /drives/{id}/items/{item}` removes a folder and
 * everything under it, so this is the same request `rmR` sends and the
 * emptiness check is the only thing separating them. Aliasing the two --
 * which this was -- destroyed the whole subtree for every caller that does
 * not pre-check emptiness itself, and the command builders are the only
 * callers that do: FUSE, `ws.fs` and the sandbox runtimes all reach the op
 * directly.
 */
export async function rmdir(accessor: SharePointAccessor, path: PathSpec): Promise<void> {
  if (path.resourcePath === '') return
  const resolved = await accessor.resolve(path.resourcePath)
  if (resolved.driveId === null || resolved.itemPath === null) return
  const loc = accessor.loc(resolved, path.resourcePath)
  if (!(await driveRootEmpty(accessor.config, loc))) throw enotempty(path)
  await graphDelete(accessor.config, loc.item())
  await invalidateAfterUnlink(path)
}

export const exists = makeExists<SharePointAccessor>(stat)

export async function rename(
  accessor: SharePointAccessor,
  src: PathSpec,
  dst: PathSpec,
): Promise<void> {
  const srcResolved = await resolvedItem(accessor, src)
  const dstResolved = await resolvedItem(accessor, dst)
  await renameReplace(
    accessor.config,
    accessor.loc(srcResolved, src.resourcePath),
    accessor.loc(dstResolved, dst.resourcePath),
  )
  await invalidateSubtree(dst)
  await invalidateSubtree(src)
}

export async function copy(
  accessor: SharePointAccessor,
  src: PathSpec,
  dst: PathSpec,
): Promise<void> {
  const srcResolved = await resolvedItem(accessor, src)
  const dstResolved = await resolvedItem(accessor, dst)
  await copyTree(
    accessor.config,
    accessor.loc(srcResolved, src.resourcePath),
    accessor.loc(dstResolved, dst.resourcePath),
  )
  await invalidateAfterWrite(dst)
}

export const truncate = makeTruncate<SharePointAccessor>(read, write)

export async function du(
  accessor: SharePointAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<number> {
  try {
    const info = await stat(accessor, path, index)
    if (info.type !== FileType.DIRECTORY) return info.size ?? 0
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ENOENT') throw error
  }
  const resolved = await accessor.resolve(path.resourcePath)
  if (resolved.driveId === null) return 0
  return duTreeTotal(accessor.config, accessor.loc(resolved, path.resourcePath))
}

export async function duEntries(
  accessor: SharePointAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<[[string, number][], number]> {
  try {
    const info = await stat(accessor, path, index)
    if (info.type !== FileType.DIRECTORY) return [[], info.size ?? 0]
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ENOENT') throw error
  }
  const resolved = await accessor.resolve(path.resourcePath)
  if (resolved.driveId === null) return [[], 0]
  return duTreeEntries(accessor.config, accessor.loc(resolved, path.resourcePath))
}

function driveResolved(siteId: string, driveId: string): ResolvedSharePointPath {
  return { level: 'drive', siteId, driveId, itemPath: null }
}

function pushNamespaceDir(
  results: string[],
  key: string,
  name: string,
  depth: number,
  isEmpty: boolean | null,
  tree: PredNode,
  options: FindOptions,
): void {
  if (options.maxDepth != null && depth > options.maxDepth) return
  const entry: FindEntry = { key, name, kind: 'd', depth, isEmpty }
  if (!keep(entry, tree, options.minDepth)) return
  // Directories count as size 0 for -size (documented GNU divergence).
  if (options.minSize != null && options.minSize > 0) return
  results.push(key)
}

// An unscoped SharePoint mount exposes two synthetic directory levels above
// the document libraries (`/<Site>/<Library>/...`). `readdir` walks them, so
// `find` has to as well: delegating straight to findItems would need a
// driveId the namespace levels do not have, and the whole tree would come
// back empty. Each library subtree is walked with a depth offset so
// -maxdepth/-mindepth count from the real start path.
async function findNamespace(
  accessor: SharePointAccessor,
  path: PathSpec,
  resolved: ResolvedSharePointPath,
  options: FindOptions,
): Promise<string[]> {
  const tree = optionsTree(options)
  const base = stripSlash(path.resourcePath)
  const atRoot = resolved.level === 'root'
  const offset = atRoot ? 1 : 0
  const sites: [string, string][] = atRoot
    ? await accessor.siteEntries()
    : [[base, resolved.siteId ?? '']]
  const results: string[] = []
  let startEmpty = sites.length === 0
  for (const [siteName, siteId] of sites) {
    const siteKey = atRoot ? siteName : base
    const wantDrives =
      options.empty === true || options.maxDepth == null || options.maxDepth >= offset + 1
    const drives = wantDrives ? await accessor.driveEntries(siteId) : []
    if (atRoot) {
      pushNamespaceDir(results, `/${siteKey}`, siteName, 1, drives.length === 0, tree, options)
    } else {
      startEmpty = drives.length === 0
    }
    for (const [driveName, driveId] of drives) {
      const driveKey = `${siteKey}/${driveName}`
      const loc = accessor.loc(driveResolved(siteId, driveId), driveKey)
      const empty = options.empty === true ? await driveRootEmpty(accessor.config, loc) : null
      pushNamespaceDir(results, `/${driveKey}`, driveName, offset + 1, empty, tree, options)
      if (options.maxDepth != null && options.maxDepth <= offset + 1) continue
      results.push(
        ...(await findItems(
          accessor.config,
          loc,
          driveName,
          () => Promise.resolve(false),
          options,
          {
            depthOffset: offset + 1,
            emitStart: false,
          },
        )),
      )
    }
  }
  emitStartPath(results, base === '' ? '/' : `/${base}`, startBasename(path.virtual), {
    kind: 'd',
    isEmpty: options.empty === true ? startEmpty : null,
    exists: true,
    tree,
    maxDepth: options.maxDepth,
    minDepth: options.minDepth,
    minSize: options.minSize,
    maxSize: options.maxSize,
  })
  return results.sort(compareCodePoints)
}

export async function find(
  accessor: SharePointAccessor,
  path: PathSpec,
  options: FindOptions = {},
): Promise<string[]> {
  const resolved = await accessor.resolve(path.resourcePath)
  if (resolved.driveId !== null) {
    return findItems(
      accessor.config,
      accessor.loc(resolved, path.resourcePath),
      startBasename(path.virtual),
      async () => (await stat(accessor, path)).type === FileType.DIRECTORY,
      options,
    )
  }
  if (resolved.level === 'root' || (resolved.level === 'site' && resolved.siteId !== null)) {
    return findNamespace(accessor, path, resolved, options)
  }
  return []
}
