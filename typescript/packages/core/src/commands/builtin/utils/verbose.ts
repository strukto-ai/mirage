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

// Render GNU `rm -v` lines for a removed tree, deepest entry first. GNU prints
// one line per removed entry in a depth-first, children-first walk: `removed
// 'file'` for files and `removed directory 'dir'` for directories. Backends
// list children in their own order, so entries sort by virtual path and emit in
// reverse: a lexical path sort is a pre-order walk (`/` precedes any name char,
// so a directory always precedes its children) and its reverse is a valid
// children-first order — deterministic across every backend, matching GNU
// exactly on a single-child chain. Mirrors Python `removal_lines`.
export function removalLines(entries: { path: string; isDir: boolean }[]): string[] {
  const ordered = [...entries].sort((a, b) => (a.path < b.path ? 1 : a.path > b.path ? -1 : 0))
  return ordered.map((e) => {
    // Object stores hand back directory paths with a trailing slash; GNU never
    // prints one, so normalize (root "/" excepted).
    const p = e.path.replace(/\/+$/, '') || '/'
    return e.isDir ? `removed directory '${p}'` : `removed '${p}'`
  })
}
