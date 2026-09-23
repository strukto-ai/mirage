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

import { type FileStat, FileType, PathSpec } from '../../../../types.ts'
import { mountKey } from '../../../../utils/key_prefix.ts'

export type StatDoor = (p: PathSpec) => Promise<FileStat>
export type MkdirDoor = (p: PathSpec, parents?: boolean) => Promise<void>

/**
 * Where extraction lands: the explicit operand, else the cwd.
 *
 * The explicit operand is tar's last -C or unzip's -d; both arrive as
 * resolved virtual-path strings in the TypeScript flag bag, and the cwd
 * is virtual too, so no per-door-space split exists here the way it
 * does in Python (whose accessor doors speak mount-relative paths).
 */
export function extractDest(explicit: string | null, cwd: string): string {
  const target = explicit ?? cwd
  return target !== '' ? target : '/'
}

export function flatPathSpec(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    vfsPath: mountKey(virtual, ''),
    resolved: true,
  })
}

async function dirExists(stat: StatDoor, level: PathSpec): Promise<boolean> {
  try {
    return (await stat(level)).type === FileType.DIRECTORY
  } catch {
    // A stat miss here only means "not standing yet"; mkdir answers.
    return false
  }
}

/**
 * Create one directory chain top-down, skipping what exists.
 *
 * The dispatch mkdir op is single-level on most backends (the
 * `mkdirParents` knob is a per-backend exception), so extraction walks
 * the chain itself the way relay cp does: probe, then create only what
 * is missing, memoized per run so an archive of many files stats each
 * ancestor once.
 */
export async function ensureDir(
  dirPath: string,
  toSpec: (virtual: string) => PathSpec,
  mkdir: MkdirDoor,
  stat: StatDoor,
  made: Set<string>,
): Promise<void> {
  const parts = dirPath.split('/').filter((part) => part !== '')
  for (let i = 1; i <= parts.length; i += 1) {
    const level = `/${parts.slice(0, i).join('/')}`
    if (made.has(level)) continue
    if (!(await dirExists(stat, toSpec(level)))) {
      await mkdir(toSpec(level))
    }
    made.add(level)
  }
}
