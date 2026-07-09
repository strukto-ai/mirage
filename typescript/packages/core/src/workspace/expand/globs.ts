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

import { mountKey } from '../../utils/key_prefix.ts'
import type { Resource } from '../../resource/base.ts'
import { PathSpec } from '../../types.ts'
import type { MountRegistry } from '../mount/registry.ts'
import { rstripSlash } from '../../utils/slash.ts'

export interface ResourceWithGlob extends Resource {
  glob(paths: readonly PathSpec[], prefix?: string): Promise<PathSpec[]>
}

function hasGlob(r: Resource): r is ResourceWithGlob {
  return 'glob' in r && typeof (r as { glob?: unknown }).glob === 'function'
}

// Stamp a glob match with the display form the user's word implies.
// Bash expands `sub/*.txt` to relative matches (`sub/a.txt`), keeping
// the typed prefix. The glob item's rawPath records the word as typed;
// matches rebuild it by swapping the resolved directory prefix for the
// typed one. Absolute words (no rawPath) keep the resolved virtual.
function matchDisplay(item: PathSpec, match: PathSpec): PathSpec {
  if (item.rawPath === null || match.rawPath !== null) return match
  if (!match.virtual.startsWith(item.directory)) return match
  const rawDir = item.rawPath.slice(0, item.rawPath.lastIndexOf('/') + 1)
  const display = rawDir + match.virtual.slice(item.directory.length)
  return new PathSpec({
    virtual: match.virtual,
    directory: match.directory,
    pattern: match.pattern,
    resolved: match.resolved,
    resourcePath: match.resourcePath,
    rawPath: display,
  })
}

export async function resolveGlobs(
  classified: readonly (string | PathSpec)[],
  registry: MountRegistry,
): Promise<(string | PathSpec)[]> {
  const result: (string | PathSpec)[] = []
  for (const item of classified) {
    if (item instanceof PathSpec && item.pattern !== null) {
      const mount = registry.mountFor(item.virtual)
      if (mount === null || !hasGlob(mount.resource)) {
        result.push(item)
        continue
      }
      const prefix = rstripSlash(mount.prefix)
      const withPrefix = new PathSpec({
        virtual: item.virtual,
        directory: item.directory,
        pattern: item.pattern,
        resolved: item.resolved,
        resourcePath: mountKey(item.virtual, prefix),
        rawPath: item.rawPath,
      })
      try {
        const resolved = await mount.resource.glob([withPrefix], prefix)
        // bash with nullglob off: a zero-match glob stays the literal
        // word instead of vanishing.
        if (resolved.length === 0) {
          result.push(withPrefix)
        } else {
          for (const p of resolved) result.push(matchDisplay(withPrefix, p))
        }
      } catch {
        result.push(withPrefix)
      }
    } else {
      result.push(item)
    }
  }
  return result
}
