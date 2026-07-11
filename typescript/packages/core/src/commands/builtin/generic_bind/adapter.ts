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
import type { PathSpec } from '../../../types.ts'
import { type FileStat } from '../../../types.ts'
import { resolveGlobWith } from '../../../utils/glob_walk.ts'
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
  maxGlobMatches?: number,
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
  duTotal?: DuTotalOp<A>
  duAll?: DuAllOp<A>
}

export function resolveGlobOf<A extends Accessor = Accessor>(ops: CommandIO<A>): ResolveGlobOp<A> {
  return makeResolveGlob(ops.readdir, ops.maxGlobMatches)
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
