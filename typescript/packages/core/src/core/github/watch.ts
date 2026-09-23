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

import type { GitHubAccessor } from '../../accessor/github.ts'
import type { PathSpec, WalkEntry } from '../../types.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import type { DeltaHook } from '../../watch/base.ts'
import { ListingDeltaHook } from '../../watch/delta.ts'
import { IncompleteWalkError } from '../../watch/errors.ts'
import { fetchTree } from './client.ts'
import { buildTreeMap } from './tree.ts'

/**
 * One recursive git tree fetch feeding the generic listing differ.
 *
 * `GET /git/trees/{ref}?recursive=1` returns every path in the repository with
 * its object sha, so a pull is one request whatever the repository's shape, and
 * the fingerprint is the sha itself. That is the strongest fingerprint any
 * mirage backend has: git is content-addressed, so identical bytes have an
 * identical sha and a rewrite that changes nothing correctly reports nothing.
 *
 * A mount is pinned to one ref, so what this detects is that ref moving.
 * Nothing is reported while the branch sits still, however much is pushed
 * elsewhere in the repository.
 */
export class GitHubWalk {
  private readonly accessor: GitHubAccessor

  constructor(accessor: GitHubAccessor) {
    this.accessor = accessor
  }

  async *walk(root: PathSpec): AsyncGenerator<WalkEntry> {
    const accessor = this.accessor
    const prefix = mountPrefixOf(root.virtual, root.vfsPath)
    const { tree, truncated } = await fetchTree(
      accessor.transport,
      accessor.owner,
      accessor.repo,
      accessor.ref,
    )
    if (truncated) {
      throw new IncompleteWalkError(
        `github tree for ${accessor.owner}/${accessor.repo}@${accessor.ref} was truncated; ` +
          'cannot diff a partial tree',
      )
    }
    // A complete tree for the ref is exactly what the accessor holds, and
    // find/du/grep's scope counter read it directly. Discarding it here
    // left them answering from the tree the mount was built with until an
    // unrelated read happened to refill the index, so a pull that reported
    // a CREATE was followed by a find that could not see the file.
    accessor.tree = buildTreeMap(tree)
    const stem = stripSlash(rstripSlash(root.vfsPath))
    const base = stem !== '' ? `${stem}/` : ''
    for (const item of tree) {
      if (base !== '' && !item.path.startsWith(base)) continue
      const virtual = prefix !== '' ? `${prefix}/${item.path}` : `/${item.path}`
      if (item.type === 'tree') {
        yield { virtual, isDir: true, fingerprint: null }
        continue
      }
      yield {
        virtual,
        isDir: false,
        fingerprint: item.sha,
        size: item.size ?? null,
      }
    }
  }
}

export function buildDeltaHook(accessor: GitHubAccessor): DeltaHook {
  const walk = new GitHubWalk(accessor)
  return new ListingDeltaHook(walk.walk.bind(walk))
}
