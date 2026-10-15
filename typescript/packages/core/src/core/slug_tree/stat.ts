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

import { enoent } from '../../errors/fs.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import { folderRow } from './rows.ts'

/** Stat a path of the tree: the root, or the row its folder names. */
export function treeStat(path: PathSpec, entry: FileStat | null): FileStat {
  if (stripSlash(path.mountPath) === '') return folderRow('/')
  if (entry === null) throw enoent(path.virtual)
  return entry
}
