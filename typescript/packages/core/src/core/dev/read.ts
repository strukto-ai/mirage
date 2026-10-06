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
import { read as ramRead } from '../ram/read.ts'
import { norm } from '../../utils/path.ts'
import type { PathSpec } from '../../types.ts'
import { einval } from '../../errors/fs.ts'
import { activeDevice } from './device.ts'

const ENDLESS_READ = 'cannot read an endless device without a size'

export function read(
  accessor: RAMAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  const device = activeDevice(accessor, norm(path.mountPath))
  if (device === null) return ramRead(accessor, path, index)
  if (device === 'null') return Promise.resolve(new Uint8Array(0))
  throw einval(path, ENDLESS_READ)
}

export function readRange(
  accessor: RAMAccessor,
  path: PathSpec,
  index: IndexCacheStore | undefined,
  offset: number,
  size: number | null,
): Promise<Uint8Array> {
  const device = activeDevice(accessor, norm(path.mountPath))
  if (device === null) {
    return ramRead(accessor, path, index, { offset, ...(size !== null ? { size } : {}) })
  }
  if (device === 'null') return Promise.resolve(new Uint8Array(0))
  if (size === null) throw einval(path, ENDLESS_READ)
  return Promise.resolve(new Uint8Array(size))
}
