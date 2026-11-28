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

import type { Evicted, SetDirOptions } from '@struktoai/mirage-core/cache/index/config'
import { RAMIndexCacheStore } from '@struktoai/mirage-core/cache/index/ram'
import type { DirListing } from '@struktoai/mirage-core/types'
import { type FileStat, PathSpec } from '@struktoai/mirage-core/types'
import { rstripSlash, stripSlash } from '@struktoai/mirage-core/utils/slash'
import { vi } from 'vitest'
import { accountOf, HfHubAccessor } from '@struktoai/mirage-core/accessor/hf_hub'
import type { HfRepoConfig } from '@struktoai/mirage-core/vfs/hf_buckets/config'
import * as client from '@struktoai/mirage-core/core/hf_hub/client'
import { readdir } from '@struktoai/mirage-core/core/hf_hub/readdir'

/** Expire every listing immediately except the optional live key. */
export class ExpiredOnArrival extends RAMIndexCacheStore {
  constructor(private readonly live: string | null = null) {
    super({ ttl: 86_400 })
  }

  private expiryFor(path: string, expiredAt?: Date | null): Date | null | undefined {
    return path === this.live ? expiredAt : new Date(0)
  }

  override setDir(
    path: string,
    entries: readonly [string, FileStat][],
    expiredAt?: Date | null,
    options?: SetDirOptions,
  ): Promise<Evicted[]> {
    return super.setDir(path, entries, this.expiryFor(path, expiredAt), options)
  }

  override refillDir(
    path: string,
    entries: readonly [string, FileStat][],
    token: string,
    expiredAt?: Date | null,
    options: SetDirOptions & { partial?: boolean } = {},
  ): Promise<Evicted[] | null> {
    return super.refillDir(path, entries, token, this.expiryFor(path, expiredAt), options)
  }

  override setPartialDir(
    path: string,
    entries: readonly [string, FileStat][],
    expiredAt?: Date | null,
  ): Promise<void> {
    return super.setPartialDir(path, entries, this.expiryFor(path, expiredAt))
  }

  override seed(
    entries: ReadonlyMap<string, FileStat>,
    children: ReadonlyMap<string, readonly string[]>,
    expiresAt: Date,
    version: string | null = null,
  ): void {
    const live = [...children].filter(([path]) => path === this.live)
    super.seed(
      entries,
      new Map([...children].filter(([path]) => path !== this.live)),
      new Date(0),
      version,
    )
    super.seed(new Map(), new Map(live), expiresAt, version)
  }
}

/** A PathSpec for a mount-local path under an optional mount prefix. */
export function ps(path: string, prefix = ''): PathSpec {
  const rel = stripSlash(path)
  const stem = rstripSlash(prefix)
  const virtual =
    stem === '' ? (rel === '' ? '/' : `/${rel}`) : rel === '' ? stem : `${stem}/${rel}`
  const parent = virtual.slice(0, virtual.lastIndexOf('/')) || '/'
  return new PathSpec({ virtual, directory: parent, vfsPath: rel })
}

/** The errno an fs op refused with, which is what a backend test pins. */
export async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run()
  } catch (err) {
    return (err as { code?: string }).code
  }
  return undefined
}

function page(rows: unknown[]): {
  data: unknown[]
  status: number
  headers: Record<string, string>
} {
  return { data: rows, status: 200, headers: {} }
}

export const ROWS = [
  { type: 'file', oid: 'oid-a', size: 7, path: 'a.txt' },
  { type: 'file', oid: 'oid-b', size: 3, path: 'd/b.txt' },
  { type: 'directory', oid: 'tree-d', size: 0, path: 'd' },
]

/** A handle on `acme/widget` over an account of its own, as a mount builds. */
export function handle(config: Partial<HfRepoConfig> = {}, kind?: string): HfHubAccessor {
  const repo: HfRepoConfig = { repoId: 'acme/widget', ...config }
  return new HfHubAccessor(accountOf(repo), repo, kind)
}

/** An accessor whose tree walk answers `rows` locally. */
export function walking(rows: unknown[] = ROWS): HfHubAccessor {
  vi.spyOn(client, 'hubGetResponse').mockResolvedValue(page(rows))
  return handle()
}

/**
 * The row the folder holding `path` lists for it, as the mount finds it: a
 * listing of this backend is the whole tree, so one folder's listing names
 * any row below the root.
 */
export async function rowAt(accessor: HfHubAccessor, path: PathSpec): Promise<FileStat | null> {
  const rel = stripSlash(path.vfsPath)
  if (rel === '') return null
  const cut = rel.lastIndexOf('/')
  const folder = cut === -1 ? '' : rel.slice(0, cut)
  let listing: DirListing
  try {
    listing = await readdir(accessor, ps(folder))
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null
    throw err
  }
  return listing.entries.find((row) => row.name === rel.slice(cut + 1)) ?? null
}
