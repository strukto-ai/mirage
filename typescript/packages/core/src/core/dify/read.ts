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

import type { DifyAccessor } from '../../accessor/dify.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { fileEntry, joinLines } from '../slug_tree/read.ts'
import { scalarString } from '../slug_tree/rows.ts'
import { getDocumentSegments, iterSegmentPages } from './client.ts'
import { DIFY_TREE } from './tree.ts'

const ENC = new TextEncoder()

export function segmentText(segment: Record<string, unknown>): string {
  return scalarString(segment.content) ?? ''
}

/**
 * Read a document, optionally only a byte range of it.
 *
 * A document is rendered here from its segments, so its bytes do not exist
 * until we make them and the window can only be taken afterwards, the same
 * way the rendered branches of gdrive, slack and discord take theirs.
 *
 * Args:
 *   accessor: Dify accessor.
 *   path: the path to read.
 *   index: listing cache, consulted for the entry.
 *   options: `{offset, size}`, the byte window, or absent for the whole file.
 */
export async function read(
  accessor: DifyAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
  options?: { offset?: number; size?: number },
): Promise<Uint8Array> {
  const entry = await fileEntry(DIFY_TREE, accessor, path, index)
  const segments = await getDocumentSegments(accessor, entry.id)
  const rendered = ENC.encode(segments.map((segment) => segmentText(segment)).join('\n'))
  return sliceWindow(rendered, options?.offset ?? 0, options?.size ?? null)
}

export async function* readStream(
  accessor: DifyAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  const entry = await fileEntry(DIFY_TREE, accessor, path, index)
  yield* joinLines(segmentTexts(accessor, entry.id))
}

async function* segmentTexts(accessor: DifyAccessor, documentId: string): AsyncIterable<string> {
  for await (const page of iterSegmentPages(accessor, documentId)) {
    for (const segment of page) yield segmentText(segment)
  }
}
