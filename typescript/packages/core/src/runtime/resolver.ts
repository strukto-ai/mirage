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

import { ownerPrefix } from '../utils/slash.ts'
import type { LinkChildrenSource, PrefixSource } from './types.ts'

/**
 * The name-plane questions a runtime asks about the workspace.
 *
 * What a runtime holds instead of a flat prefix listing: the questions
 * routing and listing ever ask (what mounts exist, which one owns a
 * path, which names in a directory are links), answered by whoever
 * owns the tables so a consumer never re-implements the longest-prefix
 * rule or reaches for a link table it cannot import. Answers use the
 * table's own prefix spelling; a surface with a spelling convention of
 * its own (`RuntimeFiles`) re-spells on its side of the seam.
 */
export interface MountResolver {
  /** The live mount prefixes, in the table's own spelling. */
  prefixes(): string[]
  /** The prefix owning `path` by longest match, or null. */
  ownerOf(path: string): string | null
  /**
   * The names of the symlinks in the directory `directory` names.
   *
   * Per directory, not per path, because a listing is where the answer
   * is needed and one table read serves every entry in it; asked per
   * entry it would be a readlink apiece for a fact the name plane can
   * hand over whole. Answers for the directory the path *names*,
   * resolving a link the way the listing itself is resolved, so a
   * listing through an alias is marked from the directory it actually
   * read.
   */
  linkChildren(directory: string): Set<string>
}

/**
 * A MountResolver over a live prefix listing.
 *
 * The one concrete resolver: the workspace wraps whatever view it
 * wants a consumer to have (a sandbox-filtered list for the runtimes)
 * and the matching rule stays `ownerPrefix`'s. Reads its sources per
 * call, so mounts and links added or removed after construction are
 * always picked up.
 *
 * The link source is optional and answers nothing when absent, which
 * is right for a resolver built outside a workspace: there is no node
 * table, so no name can be a link.
 */
export class PrefixResolver implements MountResolver {
  private readonly source: PrefixSource
  private readonly links: LinkChildrenSource | null

  constructor(source: PrefixSource, links: LinkChildrenSource | null = null) {
    this.source = source
    this.links = links
  }

  prefixes(): string[] {
    return [...this.source()]
  }

  ownerOf(path: string): string | null {
    return ownerPrefix(this.source(), path)
  }

  linkChildren(directory: string): Set<string> {
    if (this.links === null) return new Set()
    return this.links(directory)
  }
}
