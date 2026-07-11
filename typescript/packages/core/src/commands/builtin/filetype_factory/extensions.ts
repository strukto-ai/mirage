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
import * as featherModule from '../../../core/filetype/feather.ts'
import * as hdf5Module from '../../../core/filetype/hdf5.ts'
import * as parquetModule from '../../../core/filetype/parquet.ts'
import type { PathSpec } from '../../../types.ts'

interface LsMeta {
  size: number
  modified: string | null
  name: string
}

export interface FiletypeModule {
  describe(raw: Uint8Array): string | Promise<string>
  cat(raw: Uint8Array): Uint8Array | Promise<Uint8Array>
  head(raw: Uint8Array, n: number): Uint8Array | Promise<Uint8Array>
  tail(raw: Uint8Array, n: number): Uint8Array | Promise<Uint8Array>
  wc(raw: Uint8Array): number | Promise<number>
  ls(raw: Uint8Array, meta: LsMeta): Uint8Array | Promise<Uint8Array>
  lsFallback(meta: LsMeta): Uint8Array
  stat(raw: Uint8Array): Uint8Array | Promise<Uint8Array>
  grep(raw: Uint8Array, pattern: string, ignoreCase: boolean): Uint8Array | Promise<Uint8Array>
  cut(raw: Uint8Array, columns: readonly string[]): Uint8Array | Promise<Uint8Array>
}

export interface FiletypeEntry {
  fmt: string
  exts: readonly string[]
  module: FiletypeModule
}

export const FILETYPE_ENTRIES: readonly FiletypeEntry[] = [
  { fmt: 'parquet', exts: ['.parquet'], module: parquetModule },
  { fmt: 'feather', exts: ['.feather', '.arrow', '.ipc'], module: featherModule },
  { fmt: 'hdf5', exts: ['.h5', '.hdf5'], module: hdf5Module },
]

export type ReadBytesFn<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
) => Promise<Uint8Array>

export type StatEntryFn<A extends Accessor = Accessor> = (
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
) => Promise<{
  readonly size: number | null
  readonly modified: string | null
  readonly name: string
}>
