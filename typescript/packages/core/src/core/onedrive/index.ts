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

import type { OneDriveAccessor } from '../../accessor/onedrive.ts'
import {
  invalidateAfterUnlink,
  invalidateAfterWrite,
  invalidateAncestors,
} from '../../cache/context.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { startBasename } from '../../commands/builtin/findEval.ts'
import { record } from '../../observe/context.ts'
import type { FindOptions } from '../../resource/base.ts'
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { GraphError, graphDelete, graphGet, graphList } from '../msgraph/client.ts'
import {
  copyTree,
  createChildFolder,
  duTreeEntries,
  duTreeTotal,
  findItems,
  readItem,
  readdirItems,
  renameReplace,
  statItem,
  streamItem,
  writeItem,
} from '../msgraph/drive.ts'

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

export async function read(
  accessor: OneDriveAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
): Promise<Uint8Array> {
  return readItem(
    accessor.config,
    accessor.loc(path.resourcePath),
    path.virtual,
    path.resourcePath,
    'onedrive',
  )
}

export async function* stream(
  accessor: OneDriveAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  yield* streamItem(
    accessor.config,
    accessor.loc(path.resourcePath),
    path.virtual,
    path.resourcePath,
    'onedrive',
  )
}

export async function readdir(
  accessor: OneDriveAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const target = directoryPath(path)
  const key = virtualKey(path)
  if (index !== undefined) {
    const cached = await index.listDir(key)
    if (cached.entries !== undefined && cached.entries !== null) return cached.entries
  }
  const prefix = mountPrefixOf(target.virtual, target.resourcePath)
  return readdirItems(
    accessor.config,
    accessor.loc(target.resourcePath),
    index,
    prefix,
    target.resourcePath,
    key,
    target,
    () => stat(accessor, target, index),
  )
}

export async function stat(
  accessor: OneDriveAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  if (path.resourcePath === '') {
    try {
      const item = await graphGet(accessor.config, accessor.loc('').item())
      return new FileStat({
        name: '/',
        type: FileType.DIRECTORY,
        size: typeof item.size === 'number' ? item.size : null,
        modified: typeof item.lastModifiedDateTime === 'string' ? item.lastModifiedDateTime : null,
      })
    } catch (error) {
      if (error instanceof GraphError && error.status === 404) throw enoent(path)
      throw error
    }
  }
  return statItem(accessor.config, accessor.loc(path.resourcePath), path, virtualKey(path), index)
}

export async function write(
  accessor: OneDriveAccessor,
  path: PathSpec,
  data: Uint8Array,
): Promise<void> {
  const startMs = performance.now()
  await writeItem(accessor.config, accessor.loc(path.resourcePath), data)
  record('write', path.resourcePath, 'onedrive', data.length, startMs)
  await invalidateAfterWrite(path)
}

export async function create(accessor: OneDriveAccessor, path: PathSpec): Promise<void> {
  await write(accessor, path, new Uint8Array())
}

async function createDir(accessor: OneDriveAccessor, path: string): Promise<void> {
  const parent = parentPath(path)
  await createChildFolder(accessor.config, accessor.loc(parent).item('/children'), baseName(path))
}

export async function mkdir(
  accessor: OneDriveAccessor,
  path: PathSpec,
  parents = false,
): Promise<void> {
  const key = path.resourcePath
  if (key === '') return
  if (parents) {
    const parts = key.split('/')
    for (let index = 1; index <= parts.length; index++) {
      await createDir(accessor, parts.slice(0, index).join('/'))
    }
  } else {
    await createDir(accessor, key)
  }
  await invalidateAfterWrite(path)
  if (parents) await invalidateAncestors(path)
}

export async function unlink(accessor: OneDriveAccessor, path: PathSpec): Promise<void> {
  try {
    await graphDelete(accessor.config, accessor.loc(path.resourcePath).item())
  } catch (error) {
    if (error instanceof GraphError && error.status === 404) throw enoent(path)
    throw error
  }
  await invalidateAfterUnlink(path)
}

export async function rmR(accessor: OneDriveAccessor, path: PathSpec): Promise<void> {
  if (path.resourcePath === '') return
  await graphDelete(accessor.config, accessor.loc(path.resourcePath).item())
  await invalidateAfterUnlink(path)
}

export async function rmdir(accessor: OneDriveAccessor, path: PathSpec): Promise<void> {
  await rmR(accessor, path)
}

export async function exists(accessor: OneDriveAccessor, path: PathSpec): Promise<boolean> {
  try {
    await stat(accessor, path)
    return true
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return false
    throw error
  }
}

export async function rename(
  accessor: OneDriveAccessor,
  src: PathSpec,
  dst: PathSpec,
): Promise<void> {
  await renameReplace(
    accessor.config,
    accessor.loc(src.resourcePath),
    accessor.loc(dst.resourcePath),
  )
  await invalidateAfterWrite(dst)
  await invalidateAfterUnlink(src)
}

export async function copy(
  accessor: OneDriveAccessor,
  src: PathSpec,
  dst: PathSpec,
): Promise<void> {
  await copyTree(accessor.config, accessor.loc(src.resourcePath), accessor.loc(dst.resourcePath))
  await invalidateAfterWrite(dst)
}

export async function truncate(
  accessor: OneDriveAccessor,
  path: PathSpec,
  length: number,
): Promise<void> {
  let data: Uint8Array
  try {
    data = await read(accessor, path)
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ENOENT') throw error
    data = new Uint8Array()
  }
  const resized = new Uint8Array(length)
  resized.set(data.slice(0, length))
  await write(accessor, path, resized)
}

export async function du(
  accessor: OneDriveAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<number> {
  try {
    const info = await stat(accessor, path, index)
    if (info.type !== FileType.DIRECTORY) return info.size ?? 0
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ENOENT') throw error
  }
  return duTreeTotal(accessor.config, accessor.loc(path.resourcePath))
}

export async function duAll(
  accessor: OneDriveAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<[[string, number][], number]> {
  try {
    const info = await stat(accessor, path, index)
    if (info.type !== FileType.DIRECTORY) return [[], info.size ?? 0]
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ENOENT') throw error
  }
  return duTreeEntries(accessor.config, accessor.loc(path.resourcePath))
}

export async function find(
  accessor: OneDriveAccessor,
  path: PathSpec,
  options: FindOptions = {},
): Promise<string[]> {
  return findItems(
    accessor.config,
    accessor.loc(path.resourcePath),
    startBasename(path.virtual),
    async () => (await stat(accessor, path)).type === FileType.DIRECTORY,
    options,
  )
}

export async function listVersions(
  accessor: OneDriveAccessor,
  path: PathSpec,
): Promise<Record<string, unknown>[]> {
  return graphList(accessor.config, accessor.loc(path.resourcePath).item('/versions'))
}
