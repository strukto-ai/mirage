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

import type { Accessor } from '../../accessor/base.ts'
import type { ContentType } from '../../types.ts'
import type { Codec } from '../hierarchy/codec.ts'
import type { Reader } from '../hierarchy/read.ts'
import type { Lister } from '../hierarchy/readdir.ts'
import type { DetectFn } from '../hierarchy/scope.ts'

export type Row = Record<string, unknown>

/** One leaf a row renders as: its kind, suffix codec and content type. */
export type Leaf = readonly [kind: string, codec: Codec, filetype: ContentType]

/**
 * What the shared row tree asks of one vector store.
 *
 * The tree lists the store's tables (or pins one), adds one directory level
 * per `groupBy` column, and renders one file per row and suffix. The shared
 * kit answers the catalog, stat, read dispatch and the ranked search; the
 * store answers its own listing below a table (`children`), its `readers`,
 * and how a ranked row spells its path and body (`hit`). `drops` says whether
 * a rank, read under `rankKey`, falls short of a positive threshold. Mirrors
 * `VectorTree` in `mirage/core/vector/types.py`.
 */
export interface VectorTree<A extends Accessor> {
  readonly detect: (accessor: A) => DetectFn
  readonly pinned: (accessor: A) => string | null
  readonly searchLimit: (accessor: A) => number
  readonly listTables: (accessor: A) => Promise<string[]>
  readonly tableExists: (accessor: A, table: string) => Promise<boolean>
  readonly children: Lister<A>
  readonly readers: Readonly<Record<string, Reader<A>>>
  readonly searchRows: (accessor: A, table: string, query: string, limit: number) => Promise<Row[]>
  readonly rankKey: string
  readonly drops: (rank: number, threshold: number) => boolean
  readonly hit: (accessor: A, row: Row) => [string[], Uint8Array]
}
