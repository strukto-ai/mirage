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

import { type IndexCacheStore, type PathSpec, recordStream } from '@struktoai/mirage-core'
import type { HfAccessor } from '../../accessor/hf.ts'
import { DEFAULT_CHUNK_SIZE } from './constants.ts'
import { read } from './read.ts'
import { hfKey, isNotFound, rawPathOf } from './util.ts'
import { enoent } from '@struktoai/mirage-core'

export async function rangeRead(
  accessor: HfAccessor,
  path: PathSpec,
  start: number,
  end: number,
): Promise<Uint8Array> {
  return read(accessor, path, undefined, { offset: start, size: end - start })
}

export async function* stream(
  accessor: HfAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): AsyncIterable<Uint8Array> {
  const virtual = path.virtual
  const rawPath = rawPathOf(path)
  const key = hfKey(rawPath)
  const op = await accessor.operator()
  const rec = recordStream('read', virtual, accessor.resourceName)
  let reader
  try {
    reader = await op.reader(key)
  } catch (err) {
    if (isNotFound(err)) throw enoent(path)
    throw err
  }
  const buf = Buffer.alloc(chunkSize)
  for (;;) {
    const n = Number(await reader.read(buf))
    if (n <= 0) break
    const chunk = new Uint8Array(buf.subarray(0, n))
    if (rec !== null) rec.bytes += chunk.byteLength
    yield chunk
  }
}
