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
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { guessType } from '../../utils/filetype.ts'
import { basename, norm } from './utils.ts'
import { enoent } from '../../utils/errors.ts'

export function stat(accessor: RAMAccessor, path: PathSpec): Promise<FileStat> {
  const p = norm(path.mountPath)
  if (accessor.store.dirs.has(p)) {
    return Promise.resolve(
      new FileStat({
        name: basename(p),
        modified: accessor.store.modified.get(p) ?? null,
        type: FileType.DIRECTORY,
      }),
    )
  }
  const data = accessor.store.files.get(p)
  if (data === undefined) {
    throw enoent(path)
  }
  return Promise.resolve(
    new FileStat({
      name: basename(p),
      size: data.byteLength,
      modified: accessor.store.modified.get(p) ?? null,
      type: guessType(p),
    }),
  )
}
