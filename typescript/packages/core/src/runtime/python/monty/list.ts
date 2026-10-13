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

import { compareComponents } from '../../../utils/sort.ts'

/** A full entry path under `dir`, whatever shape the listing spelled. */
function joinEntry(dir: string, name: string): string {
  const clean = name.endsWith('/') ? name.slice(0, -1) : name
  if (clean.startsWith('/')) return clean
  return dir === '/' ? '/' + clean : dir + '/' + clean
}

/**
 * A listing's entries as the guest's paths, sorted as pathlib sorts: by
 * parts, each by code point. Backends spell entries differently (bare names, slash-marked
 * directories, full paths); joining each onto the directory takes all
 * three to one path.
 */
export function childPaths(path: string, names: string[]): string[] {
  return [...new Set(names.map((name) => joinEntry(path, name)))].sort(compareComponents)
}
