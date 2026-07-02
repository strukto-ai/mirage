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

import { type IndexCacheStore, type PathSpec, record } from '@struktoai/mirage-core'
import type { HfAccessor } from '../../accessor/hf.ts'
import { hfKey, isNotFound, rawPathOf } from './util.ts'
import { enoent } from '@struktoai/mirage-core'

export interface HfReadOptions {
  offset?: number
  size?: number
}

export async function read(
  accessor: HfAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
  options: HfReadOptions = {},
): Promise<Uint8Array> {
  const virtual = path.virtual
  const rawPath = rawPathOf(path)
  const key = hfKey(rawPath)
  const op = await accessor.operator()
  const readOptions: { offset?: bigint; size?: bigint } = {}
  if (options.offset !== undefined && options.offset > 0) {
    readOptions.offset = BigInt(options.offset)
  }
  if (options.size !== undefined) {
    readOptions.offset ??= 0n
    readOptions.size = BigInt(options.size)
  }
  const startMs = performance.now()
  let data: Buffer
  try {
    data =
      readOptions.offset !== undefined || readOptions.size !== undefined
        ? await op.read(key, readOptions)
        : await op.read(key)
  } catch (err) {
    if (isNotFound(err)) throw enoent(path)
    throw err
  }
  const bytes = new Uint8Array(data)
  record('read', virtual, accessor.resourceName, bytes.byteLength, startMs)
  return bytes
}
