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

import type { Accessor } from '../../../accessor/base.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import type { FindOptions } from '../../../resource/base.ts'
import { FileType, PathSpec, type FileStat } from '../../../types.ts'
import { eisdir } from '../../../utils/errors.ts'
import { DEFAULT_MAX_GLOB_MATCHES, resolveGlobWith } from '../../../utils/glob_walk.ts'
import { norm, parent } from '../../../utils/path.ts'
import { stripSlash } from '../../../utils/slash.ts'
import type { AggregateFn, CommandFnResult, CommandOpts, ProvisionFn } from '../../config.ts'

export type ReaddirOp<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
) => Promise<string[]>

type ReadBytesOp<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
) => Promise<Uint8Array>

type ReadStreamOp<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
) => AsyncIterable<Uint8Array>

export type StatOp<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
) => Promise<FileStat>

type WriteOp<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  data: Uint8Array,
) => Promise<void>

type ExistsOp<A extends Accessor = Accessor> = (accessor: A, path: PathSpec) => Promise<boolean>

type PathOp<A extends Accessor = Accessor> = (accessor: A, path: PathSpec) => Promise<void>

type MkdirOp<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  parents?: boolean,
) => Promise<void>

type RenameOp<A extends Accessor = Accessor> = (
  accessor: A,
  src: PathSpec,
  dst: PathSpec,
) => Promise<void>

type CopyOp<A extends Accessor = Accessor> = (
  accessor: A,
  src: PathSpec,
  dst: PathSpec,
) => Promise<void>

type FindOp<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  options: FindOptions,
) => Promise<string[]>

type IsDirNameOp<A extends Accessor = Accessor> = (accessor: A, child: string) => boolean | null

type DuTotalOp<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
) => Promise<number>

type DuAllOp<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
) => Promise<[[string, number][], number]>

export type ResolveGlobOp<A extends Accessor = Accessor> = (
  accessor: A,
  paths: readonly PathSpec[],
  index?: IndexCacheStore,
) => Promise<PathSpec[]>

export function makeResolveGlob<A extends Accessor = Accessor>(
  readdir: ReaddirOp<A>,
  maxGlobMatches: number = DEFAULT_MAX_GLOB_MATCHES,
): ResolveGlobOp<A> {
  return async (accessor, paths, index) =>
    resolveGlobWith(readdir, accessor, paths, index, maxGlobMatches)
}

export interface CommandIO<A extends Accessor = Accessor> {
  readdir: ReaddirOp<A>
  readBytes: ReadBytesOp<A>
  readStream: ReadStreamOp<A>
  stat: StatOp<A>
  isMounted: (accessor: A) => boolean
  local?: boolean
  maxGlobMatches?: number
  write?: WriteOp<A>
  exists?: ExistsOp<A>
  mkdir?: MkdirOp<A>
  unlink?: PathOp<A>
  rmdir?: PathOp<A>
  rmR?: PathOp<A>
  rename?: RenameOp<A>
  copy?: CopyOp<A>
  dirCopy?: CopyOp<A>
  create?: PathOp<A>
  truncate?: PathOp<A>
  find?: FindOp<A>
  isDirName?: IsDirNameOp<A>
  duTotal?: DuTotalOp<A>
  duAll?: DuAllOp<A>
}

export function resolveGlobOf<A extends Accessor = Accessor>(ops: CommandIO<A>): ResolveGlobOp<A> {
  return makeResolveGlob(ops.readdir, ops.maxGlobMatches)
}

// Whether a path that failed with ENOENT is an implicit directory. Keyed
// backends (RAM/Redis/S3) have no directory entries: stat/read of a prefix
// that only exists through deeper keys raises ENOENT. The operand's own
// readdir cannot serve as the probe: synthetic hierarchies fabricate
// children for any name (postgres answers tables/views for a missing
// schema) and database backends raise driver errors for missing tables.
// The parent listing is authoritative instead: the operand is an implicit
// directory only if its parent's readdir lists it. When the operand is the
// mount root there is no parent to list, so its own readdir decides (root
// listings are real in every backend). Any probe failure is a negative
// probe (the original ENOENT stands), never an error to surface.
async function isImplicitDir<A extends Accessor>(
  ops: CommandIO<A>,
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<boolean> {
  const target = norm(path.virtual)
  const key = stripSlash(path.resourcePath)
  if (!key) {
    try {
      const entries = await ops.readdir(accessor, path, index)
      return entries.length > 0
    } catch {
      return false
    }
  }
  const parentKey = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : ''
  const parentVirtual = parent(target)
  const parentPath = new PathSpec({
    virtual: parentVirtual,
    directory: parentVirtual,
    resourcePath: parentKey,
  })
  try {
    const entries = await ops.readdir(accessor, parentPath, index)
    return entries.some((entry) => norm(entry) === target)
  } catch {
    return false
  }
}

// Stat for the read-family chokepoint (`splitReadable`): a directory operand
// fails with EISDIR instead of succeeding (explicit, via the stat type) or
// failing with ENOENT (implicit keyed-backend directory, via a readdir
// probe), so cat/head/tail report GNU's `Is a directory` and keep the
// remaining operands (#457).
export function dirAwareStat<A extends Accessor>(
  ops: CommandIO<A>,
  accessor: A,
  index?: IndexCacheStore,
): (p: PathSpec) => Promise<FileStat> {
  return async (p) => {
    let st: FileStat
    try {
      st = await ops.stat(accessor, p, index)
    } catch (e) {
      if (
        (e as { code?: string }).code === 'ENOENT' &&
        (await isImplicitDir(ops, accessor, p, index))
      )
        throw eisdir(p)
      throw e
    }
    if (st.type === FileType.DIRECTORY) throw eisdir(p)
    return st
  }
}

async function* streamRefusingDirs<A extends Accessor>(
  ops: CommandIO<A>,
  accessor: A,
  p: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  let st: FileStat
  try {
    st = await ops.stat(accessor, p, index)
  } catch (e) {
    if (
      (e as { code?: string }).code === 'ENOENT' &&
      (await isImplicitDir(ops, accessor, p, index))
    )
      throw eisdir(p)
    throw e
  }
  if (st.type === FileType.DIRECTORY) throw eisdir(p)
  yield* ops.readStream(accessor, p, index)
}

// Read stream for the read-family per-operand chokepoint (`readOperands`):
// the operand is stat'ed first so a directory fails with EISDIR before any
// backend read runs (sftp reads of a directory raise an opaque `Failure`,
// not ENOENT), and an ENOENT for an implicit keyed-backend directory is
// refined the same way `dirAwareStat` does, before the generic formats the
// stderr line (#457). Mirrors the Python `_read_refusing_dirs`.
export function dirAwareStream<A extends Accessor>(
  ops: CommandIO<A>,
  accessor: A,
  index?: IndexCacheStore,
): (p: PathSpec) => AsyncIterable<Uint8Array> {
  return (p) => streamRefusingDirs(ops, accessor, p, index)
}

export type BuilderFn<A extends Accessor = Accessor> = (
  ops: CommandIO<A>,
  accessor: A,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
) => Promise<CommandFnResult> | CommandFnResult

export interface Builder<A extends Accessor = Accessor> {
  name: string
  fn: BuilderFn<A>
  provision?: (stat: StatOp<A>) => ProvisionFn<A>
  write?: boolean
  aggregate?: AggregateFn
  read?: boolean
}
