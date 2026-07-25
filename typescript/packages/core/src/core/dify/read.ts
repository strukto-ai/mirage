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
import { PathSpec } from '../../types.ts'
import { eisdir } from '../../utils/errors.ts'
import { getDocumentSegments, iterSegmentPages } from './_client.ts'
import { resolvePath, type ResolvedDifyPath } from './path.ts'

const ENC = new TextEncoder()

function fileId(resolved: ResolvedDifyPath, virtual: string): string {
  if (resolved.isDir || resolved.entry === null) throw eisdir(virtual)
  return resolved.entry.id
}

export function segmentText(segment: Record<string, unknown>): string {
  const value = segment.content
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function segmentsToBytes(segments: Record<string, unknown>[]): Uint8Array {
  return ENC.encode(segments.map((segment) => segmentText(segment)).join('\n'))
}

export async function readBytes(
  accessor: DifyAccessor,
  path: PathSpec | string,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  const spec = typeof path === 'string' ? PathSpec.fromStrPath(path) : path
  const resolved = await resolvePath(accessor, spec, index)
  const segments = await getDocumentSegments(accessor, fileId(resolved, spec.virtual))
  return segmentsToBytes(segments)
}

export async function* readStream(
  accessor: DifyAccessor,
  path: PathSpec | string,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  const spec = typeof path === 'string' ? PathSpec.fromStrPath(path) : path
  const resolved = await resolvePath(accessor, spec, index)
  const documentId = fileId(resolved, spec.virtual)
  let first = true
  for await (const pageSegments of iterSegmentPages(accessor, documentId)) {
    for (const segment of pageSegments) {
      if (first) {
        first = false
      } else {
        yield ENC.encode('\n')
      }
      yield ENC.encode(segmentText(segment))
    }
  }
}
