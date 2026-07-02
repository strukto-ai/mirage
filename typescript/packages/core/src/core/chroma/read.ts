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

import type { ChromaAccessor } from '../../accessor/chroma.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { fetchPageChunks, iterPageChunks, metadataString } from './_client.ts'
import { resolvePath, type ResolvedChromaPath } from './path.ts'

const ENC = new TextEncoder()

function eisdir(p: string): Error {
  const err = new Error(`EISDIR: ${p}`) as Error & { code?: string }
  err.code = 'EISDIR'
  return err
}

function fileSlug(resolved: ResolvedChromaPath, virtual: string): string {
  if (resolved.isDir) throw eisdir(virtual)
  const slug = metadataString(resolved.entry?.extra.slug)
  if (slug === null) throw eisdir(virtual)
  return slug
}

export async function readBytes(
  accessor: ChromaAccessor,
  path: PathSpec | string,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  const spec = typeof path === 'string' ? PathSpec.fromStrPath(path) : path
  const resolved = await resolvePath(accessor, spec, index)
  const text = await fetchPageChunks(accessor, fileSlug(resolved, spec.virtual))
  return ENC.encode(text)
}

export async function* readStream(
  accessor: ChromaAccessor,
  path: PathSpec | string,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  const spec = typeof path === 'string' ? PathSpec.fromStrPath(path) : path
  const resolved = await resolvePath(accessor, spec, index)
  const slug = fileSlug(resolved, spec.virtual)
  let first = true
  for await (const chunk of iterPageChunks(accessor, slug)) {
    if (first) {
      first = false
    } else {
      yield ENC.encode('\n')
    }
    yield ENC.encode(chunk)
  }
}
