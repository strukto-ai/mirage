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

import { FileType, type PathSpec } from '../../../../types.ts'
import type { Files } from '../../../../workspace/files.ts'
import { discover } from './discover.ts'
import { InvalidGitFileError, NotARepositoryError } from './errors.ts'
import { statOf } from './io.ts'
import { loadRefs, readHead } from './refs.ts'
import type { RepoLocation } from './types.ts'

/**
 * A repository embedded in a work tree, at a directory that holds its own
 * `.git`: null when git could not open one there (no HEAD, objects or refs).
 * Mirrors Python's `embedded_location`.
 *
 * @param vfs the session's files
 * @param dir the directory
 */
export async function embeddedLocation(vfs: Files, dir: PathSpec): Promise<RepoLocation | null> {
  try {
    const found = await discover(vfs, dir)
    if (found.worktree.virtual !== dir.virtual) return null
    for (const [path, kind] of [
      [found.gitdir.join('HEAD'), FileType.FILE],
      [found.commondir.join('objects'), FileType.DIRECTORY],
      [found.commondir.join('refs'), FileType.DIRECTORY],
    ] as const)
      if ((await statOf(vfs, path))?.type !== kind) return null
    return { ...found, vfs }
  } catch (err) {
    if (err instanceof NotARepositoryError || err instanceof InvalidGitFileError) return null
    throw err
  }
}

/**
 * The commit an embedded repository has checked out, which a gitlink
 * records; null on an unborn branch, which git refuses to add. Mirrors
 * Python's `embedded_head`.
 */
export async function embeddedHead(vfs: Files, location: RepoLocation): Promise<string | null> {
  const head = await readHead(vfs, location.gitdir)
  if (head.ref === null) return head.commit
  const refs = await loadRefs(vfs, location.gitdir, location.commondir)
  return refs.get(head.ref) ?? null
}
