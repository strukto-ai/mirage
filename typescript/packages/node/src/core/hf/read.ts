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

import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import { record, startOp } from '@struktoai/mirage-core/observe/context'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent } from '@struktoai/mirage-core/utils/errors'
import type { HfAccessor } from '../../accessor/hf.ts'
import { hfKey, isNotFound, rawPathOf } from './util.ts'
import { isShortRangeRefusal, sliceWindow } from '@struktoai/mirage-core/utils/ranges'

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
  const timer = startOp()
  const windowed = readOptions.offset !== undefined || readOptions.size !== undefined
  let data: Buffer
  try {
    data = windowed ? await op.read(key, readOptions) : await op.read(key)
  } catch (err) {
    if (isNotFound(err)) throw enoent(path)
    // OpenDAL's node binding refuses to return fewer bytes than the range
    // asked for, where a POSIX read comes back short, so a window that runs
    // past EOF has to be read unbounded and trimmed here. Python's binding
    // reads through a file object and is short naturally.
    if (!windowed || !isShortRangeRefusal(err)) throw err
    const whole = await op.read(key, { offset: readOptions.offset ?? 0n })
    data = Buffer.from(sliceWindow(new Uint8Array(whole), 0, options.size ?? null))
  }
  const bytes = new Uint8Array(data)
  record('read', virtual, accessor.resourceName, bytes.byteLength, timer)
  return bytes
}
