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
import type { PathSpec } from '../../types.ts'
import { decodeBase64 } from '../../utils/base64.ts'
import { perAccessor } from '../hierarchy/bind.ts'
import { makeRead as hierarchyRead } from '../hierarchy/read.ts'
import type { VectorTree } from './types.ts'

/** A blob column's bytes, stored raw or as base64 text. */
export function blobBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (typeof value === 'string') return decodeBase64(value)
  throw new Error('blob column is not bytes or base64 string')
}

/** Build a store's read over its per-kind readers. */
export function makeRead<A extends Accessor>(
  tree: VectorTree<A>,
): (accessor: A, path: PathSpec) => Promise<Uint8Array> {
  const readFor = perAccessor((accessor: A) => hierarchyRead(tree.detect(accessor), tree.readers))
  return (accessor, path) => readFor(accessor)(accessor, path)
}
