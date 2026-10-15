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

import type { BoxAccessor } from '../../accessor/box.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import type { Handed } from '../../vfs/types.ts'
import { write } from './write.ts'

export async function create(
  accessor: BoxAccessor,
  path: PathSpec,
  handed: Handed = {},
): Promise<FileStat | null> {
  // touch: create an empty file when absent. Box has no mtime-only API, so
  // touching an existing file is a no-op rather than a truncation.
  if (handed.entry !== null && handed.entry !== undefined) return null
  return write(accessor, path, new Uint8Array(0), { parent: handed.parent ?? null })
}
