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
import { hasGlob as hasGlobChars, spellMatch } from '../../utils/glob_walk.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'

export interface ResourceWithGlob extends Resource {
  glob(paths: readonly PathSpec[], prefix?: string): Promise<PathSpec[]>
}

function hasGlob(r: Resource): r is ResourceWithGlob {
  return 'glob' in r && typeof (r as { glob?: unknown }).glob === 'function'
}

// Expand a mid-path pattern level by level via the resource's glob. A glob
// in a non-final segment (`s*/x.txt`) cannot resolve in one listing: each
// glob segment is matched against its (already expanded) parent directory,
// using the backend's own single-level glob per parent, so no backend needs
// mid-path support. Matches are spelled the way bash expansion implies
// (typed head + matched tail). An intermediate match that cannot be listed
// is skipped, matching bash's directories-only descent.
async function walkSegments(
  item: PathSpec,
  resource: ResourceWithGlob,
  prefix: string,
): Promise<PathSpec[]> {
  const segments = stripSlash(item.virtual).split('/')
  const first = segments.findIndex((seg) => hasGlobChars(seg))
  const walked = segments.length - first
  let level: string[] = ['/' + segments.slice(0, first).join('/')]
  for (const seg of segments.slice(first)) {
    const gathered: string[] = []
    for (const parent of level) {
      const dirVirtual = `${rstripSlash(parent)}/`
      const spec = new PathSpec({
        virtual: dirVirtual,
        directory: dirVirtual,
        resourcePath: mountKey(dirVirtual, prefix),
        pattern: seg,
        resolved: false,
      })
      let matches: PathSpec[]
      try {
        matches = await resource.glob([spec], prefix)
      } catch (err) {
        // fs-coded failures mean this parent is not a listable directory
        // (bash skips it); anything else is a real bug and propagates.
        if ((err as { code?: string }).code === undefined) throw err
        continue
      }
      for (const m of matches) gathered.push(m.virtual)
    }
    level = gathered
    if (level.length === 0) return []
  }
  return level.map((v) => {
    const base = PathSpec.fromStrPath(v, mountKey(v, prefix))
    return new PathSpec({
      virtual: base.virtual,
      directory: base.directory,
      resourcePath: base.resourcePath,
      rawPath: spellMatch(item.rawPath, v, walked),
    })
  })
}

// Stamp a glob match with the spelling the user's word implies.
// Bash expands `sub/*.txt` to relative matches (`sub/a.txt`), keeping
// the typed prefix. The glob item's rawPath records the word as typed;
// matches rebuild it by swapping the resolved directory prefix for the
// typed one. Words with no distinct spelling (absolute: rawPath ===
// virtual) keep the resolved virtual, as do matches that already carry
// one.
function matchRaw(item: PathSpec, match: PathSpec): PathSpec {
  if (item.rawPath === item.virtual || match.rawPath !== match.virtual) return match
  if (!match.virtual.startsWith(item.directory)) return match
  const rawDir = item.rawPath.slice(0, item.rawPath.lastIndexOf('/') + 1)
  const spelled = rawDir + match.virtual.slice(item.directory.length)
  return new PathSpec({
    virtual: match.virtual,
    directory: match.directory,
    pattern: match.pattern,
    resolved: match.resolved,
    resourcePath: match.resourcePath,
    rawPath: spelled,
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
        const resolved = hasGlobChars(withPrefix.directory)
          ? await walkSegments(withPrefix, mount.resource, prefix)
          : await mount.resource.glob([withPrefix], prefix)
        // bash with nullglob off: a zero-match glob stays the literal
        // word instead of vanishing.
        if (resolved.length === 0) {
          result.push(withPrefix)
        } else {
          for (const p of resolved) result.push(matchRaw(withPrefix, p))
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
