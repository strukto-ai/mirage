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

import { LookupStatus } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { enoent, enotdir } from '../../errors/fs.ts'
import { mountPrefixOf, rekey } from '../../utils/key_prefix.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { mountRoot } from './rows.ts'
import type { LoadRows, ResolvedPath, WalkOptions } from './types.ts'

function requireIndex(index: IndexCacheStore | undefined): IndexCacheStore {
  if (index === undefined) throw new Error('slug tree: missing index')
  return index
}

function isMissing(err: unknown): boolean {
  const code = (err as { code?: string }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * A backend's whole document list, served as a directory tree.
 *
 * Every listing of the mount comes from one fetch, so the tree is written to
 * the index whole and an expired listing means the tree aged out rather than
 * that a folder went away. The members are arrow properties so they can be
 * handed around as ops without losing `this`.
 */
export class SlugTree<A> {
  constructor(private readonly load: LoadRows<A>) {}

  readonly ensure = async (
    accessor: A,
    index: IndexCacheStore,
    prefix: string,
  ): Promise<Map<string, string[]> | null> => {
    const listing = await index.listDir(mountRoot(prefix))
    if (listing.entries !== undefined && listing.entries !== null) return null
    return this.refill(accessor, index, prefix)
  }

  /**
   * Refetch the tree, write every folder's listing, return the rows.
   *
   * The rows are returned so a reader can answer from them when the index
   * itself will not serve them (fresh refusing every listing outside a
   * command).
   */
  readonly refill = async (
    accessor: A,
    index: IndexCacheStore,
    prefix: string,
  ): Promise<Map<string, string[]>> => {
    const rows = await this.load(accessor, prefix)
    const children = new Map<string, string[]>()
    for (const directory of [...rows.keys()].sort(compareCodePoints)) {
      const sorted = [...(rows.get(directory) ?? [])].sort((a, b) => compareCodePoints(a[0], b[0]))
      await index.setDir(directory, sorted)
      const stem = directory === '/' ? '/' : `${directory}/`
      children.set(
        directory,
        sorted.map(([name]) => stem + name),
      )
    }
    return new Map(
      [...index.scopeSnapshot({ entries: new Map(), children }).children].map(([path, keys]) => [
        path,
        [...keys],
      ]),
    )
  }

  readonly resolve = async (
    accessor: A,
    path: PathSpec,
    index?: IndexCacheStore,
  ): Promise<ResolvedPath> => {
    const store = requireIndex(index)
    const mountPrefix = mountPrefixOf(path.virtual, path.vfsPath)
    let refilled = await this.ensure(accessor, store, mountPrefix)
    const virtualKey = virtualKeyFor(path)
    const entry = (await store.get(virtualKey)).entry ?? null
    if (entry !== null && entry.resourceType !== 'folder') {
      return { isDir: false, virtualKey, mountPrefix, entry }
    }
    if (entry === null) {
      const listing = await store.listDir(virtualKey)
      if (listing.entries === undefined || listing.entries === null) {
        if (listing.status !== LookupStatus.EXPIRED) throw enoent(path.virtual)
        refilled ??= await this.refill(accessor, store, mountPrefix)
        if (!refilled.has(virtualKey)) throw enoent(path.virtual)
      }
    }
    return { isDir: true, virtualKey, mountPrefix, children: refilled?.get(virtualKey) }
  }

  readonly readdir = async (
    accessor: A,
    path: PathSpec,
    index?: IndexCacheStore,
  ): Promise<string[]> => {
    const resolved = await this.resolve(accessor, path, index)
    if (!resolved.isDir) throw enotdir(path.virtual)
    if (resolved.children !== undefined) return resolved.children
    const store = requireIndex(index)
    const listing = await store.listDir(resolved.virtualKey)
    if (listing.entries == null && listing.status === LookupStatus.EXPIRED) {
      const rows = (await this.refill(accessor, store, resolved.mountPrefix)).get(
        resolved.virtualKey,
      )
      if (rows !== undefined) return rows
    }
    if (listing.entries === undefined || listing.entries === null) throw enoent(path.virtual)
    return listing.entries
  }

  readonly walk = async (
    accessor: A,
    path: PathSpec,
    index?: IndexCacheStore,
    options: WalkOptions = {},
  ): Promise<string[]> => {
    const maxDepth = options.maxDepth ?? null
    const depth = options.depth ?? 0
    let resolved: ResolvedPath
    try {
      resolved = await this.resolve(accessor, path, index)
    } catch (err) {
      if (options.ignoreMissing === true && isMissing(err)) return []
      throw err
    }
    const results =
      options.includeRoot === true
        ? [options.stripPrefix === true ? path.mountPath : path.virtual]
        : []
    if (!resolved.isDir || (maxDepth !== null && depth >= maxDepth)) return results
    let children: string[]
    try {
      children = await this.readdir(accessor, path, index)
    } catch (err) {
      if (options.ignoreMissing === true && isMissing(err)) return results
      throw err
    }
    for (const child of children) {
      const childPath = PathSpec.fromStrPath(child, rekey(path.virtual, path.vfsPath, child))
      results.push(
        ...(await this.walk(accessor, childPath, index, {
          ...options,
          includeRoot: true,
          depth: depth + 1,
        })),
      )
    }
    return results
  }
}

export function virtualKeyFor(path: PathSpec): string {
  const raw = path.pattern !== null ? path.directory : path.virtual
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  if (prefix !== '') {
    const root = mountRoot(prefix)
    if (raw === root || raw.startsWith(root + '/')) {
      const trimmed = rstripSlash(raw)
      return trimmed !== '' ? trimmed : root
    }
    const rest = stripSlash(raw)
    if (rest === '') return root
    return root + '/' + rest
  }
  const stripped = stripSlash(raw)
  return stripped !== '' ? '/' + stripped : '/'
}
