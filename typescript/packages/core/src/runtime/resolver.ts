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
import type { PrefixSource } from './types.ts'

/**
 * Routing questions about the workspace mount table.
 *
 * What a runtime holds instead of a flat prefix listing: the two
 * questions routing ever asks (what mounts exist, which one owns a
 * path), answered by whoever owns the table so a consumer never
 * re-implements the longest-prefix rule. Answers use the table's own
 * prefix spelling; a surface with a spelling convention of its own
 * (`RuntimeVFS`) re-spells on its side of the seam.
 */
export interface MountResolver {
  /** The live mount prefixes, in the table's own spelling. */
  prefixes(): string[]
  /** The prefix owning `path` by longest match, or null. */
  ownerOf(path: string): string | null
}

/**
 * A MountResolver over a live prefix listing.
 *
 * The one concrete resolver: the workspace wraps whatever view it
 * wants a consumer to have (a sandbox-filtered list for the runtimes)
 * and the matching rule stays `ownerPrefix`'s. Reads the source per
 * call, so mounts added or removed after construction are always
 * picked up.
 */
export class PrefixResolver implements MountResolver {
  private readonly source: PrefixSource

  constructor(source: PrefixSource) {
    this.source = source
  }

  prefixes(): string[] {
    return [...this.source()]
  }

  ownerOf(path: string): string | null {
    return ownerPrefix(this.source(), path)
  }
}
