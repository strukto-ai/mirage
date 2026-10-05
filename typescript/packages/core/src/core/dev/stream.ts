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

import type { RAMAccessor } from '../../accessor/ram.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { readStream as ramStream } from '../ram/stream.ts'
import { norm } from '../../utils/path.ts'
import type { PathSpec } from '../../types.ts'
import { ZERO_CHUNK_SIZE } from './constants.ts'
import { activeDevice } from './device.ts'

export async function* readStream(
  accessor: RAMAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  const device = activeDevice(accessor, norm(path.mountPath))
  if (device === null) {
    yield* ramStream(accessor, path)
    return
  }
  if (device === 'null') return
  const chunk = new Uint8Array(ZERO_CHUNK_SIZE)
  for (;;) yield chunk
}
