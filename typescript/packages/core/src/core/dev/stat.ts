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
import { stat as ramStat } from '../ram/stat.ts'
import { gnuBasename, norm } from '../../utils/path.ts'
import { DEVICE_NUMBERS_KEY, FileStat, FileType, type PathSpec } from '../../types.ts'
import { DEV_RDEV } from './constants.ts'
import { activeDevice, activePipe } from './device.ts'

export function stat(
  accessor: RAMAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
): Promise<FileStat> {
  const key = norm(path.mountPath)
  const pipe = activePipe(accessor, key)
  if (pipe !== null)
    return Promise.resolve(
      new FileStat({ name: gnuBasename(key), type: FileType.FIFO, size: null }),
    )
  const device = activeDevice(accessor, key)
  if (device === null) return ramStat(accessor, path)
  const attrs = accessor.store.attrs.get(key) ?? {}
  const numbers = DEV_RDEV[device]
  if (numbers === undefined) return ramStat(accessor, path)
  return Promise.resolve(
    new FileStat({
      name: gnuBasename(key),
      size: null,
      modified: accessor.store.modified.get(key) ?? null,
      type: FileType.CHAR_DEVICE,
      mode: attrs.mode ?? null,
      uid: attrs.uid ?? null,
      gid: attrs.gid ?? null,
      atime: attrs.atime ?? null,
      extra: { [DEVICE_NUMBERS_KEY]: numbers },
    }),
  )
}
