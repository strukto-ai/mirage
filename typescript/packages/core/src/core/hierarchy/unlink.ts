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

import type { Accessor } from '../../accessor/base.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import { eisdir, enoent } from '../../errors/fs.ts'
import { INVALID, type DetectFn, type ScopeMatch } from './scope.ts'

export type DeleteFn<A extends Accessor> = (
  accessor: A,
  match: ScopeMatch,
  entry: FileStat,
) => Promise<void>

/**
 * Build a hierarchy unlink: classify, refuse, delete.
 *
 * A deleter owns only the backend delete call, handed the row the parent's
 * listing names; classification and the directory refusal happen here,
 * identically for every backend. The match rides along because a delete
 * addressed inside a container needs the container's slots (gcal deletes an
 * event from a calendar), while a globally-id-addressed backend just ignores
 * it. Mirrors `make_unlink` in `mirage/core/hierarchy/unlink.py`.
 */
export function makeUnlink<A extends Accessor>(
  detect: DetectFn,
  options: { deleters: Readonly<Record<string, DeleteFn<A>>> },
): (accessor: A, path: PathSpec, entry?: FileStat | null) => Promise<void> {
  const { deleters } = options
  return async function unlink(
    accessor: A,
    path: PathSpec,
    entry: FileStat | null = null,
  ): Promise<void> {
    const match = detect(path)
    const deleter = deleters[match.kind]
    if (deleter === undefined) {
      if (match.kind !== INVALID && !match.scope?.leaf) throw eisdir(path.virtual)
      throw enoent(path)
    }
    if (entry === null) throw enoent(path)
    await deleter(accessor, match, entry)
  }
}
