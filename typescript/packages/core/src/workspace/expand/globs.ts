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

import { childMountNames, namespaceNames } from '../../ops/namespace_view.ts'
import type { NamespaceLinks } from '../../ops/config.ts'
import { fnmatch } from '../../utils/fnmatch.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import type { Resource } from '../../resource/base.ts'
import { PathSpec } from '../../types.ts'
import type { MountEntry } from '../mount/mount.ts'
import type { MountRegistry } from '../mount/registry.ts'
import {
  globPattern,
  hasGlob as hasGlobChars,
  literalWord,
  spellMatch,
  unmarkGlobs,
} from '../../utils/glob_walk.ts'
import { CycleError } from '../../utils/path.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'

export interface ResourceWithGlob extends Resource {
  glob(paths: readonly PathSpec[], prefix?: string): Promise<PathSpec[]>
}

// Virtual paths a directory owes the namespace, matching a segment.
// Child mounts and symlinks are namespace state no backend can see, so a
// glob that stops at one backend misses both: a nested mount's keys live
// in another resource, and no resource stores a link. This is the union
// mergeReaddir already applies to a listing, filtered by the glob segment
// with the same matcher backends use, and session-filtered by
// namespaceNames so a scoped session never learns an ungranted mount's
// name from an expansion.
function namespaceChildren(
  registry: MountRegistry,
  links: NamespaceLinks | null,
  directory: string,
  pattern: string,
): string[] {
  const base = rstripSlash(directory)
  const matcher = globPattern(pattern)
  return namespaceNames(registry.mountPrefixes(), links, directory)
    .filter((name) => fnmatch(name, matcher))
    .map((name) => `${base}/${name}`)
}

// The mount owning a path, falling back to the word's own.
function mountOf(registry: MountRegistry, virtual: string, fallback: MountEntry): MountEntry {
  return registry.tryMountFor(virtual) ?? fallback
}

// The directory a backend must list to answer a glob's parent. bash
// descends through a symlinked directory during pathname expansion
// (`base/dlink/*` and `base/*/f2` both reach the target's entries), but a
// link is namespace state no backend can see, so the parent has to be
// resolved here or the listing comes back empty and the word stays
// literal. The match keeps the typed spelling, exactly as bash reports
// `base/dlink/f2` rather than the target's path.
function listingDir(links: NamespaceLinks | null, directory: string): string {
  if (links === null) return directory
  const base = rstripSlash(directory) || '/'
  let real: string
  try {
    real = links.follow(base)
  } catch (err) {
    // A loop resolves to nothing, which is bash's own answer: the word
    // matches no file and stays literal.
    if (err instanceof CycleError) return directory
    throw err
  }
  return real === base ? directory : `${rstripSlash(real)}/`
}

// Move matches found under a resolved directory back to the typed one.
function respell(virtuals: readonly string[], directory: string): string[] {
  const base = rstripSlash(directory)
  return virtuals.map((v) => `${base}/${v.slice(v.lastIndexOf('/') + 1)}`)
}

// Key matched virtual paths to their mounts and spell them as typed.
function toSpecs(
  virtuals: readonly string[],
  item: PathSpec,
  registry: MountRegistry,
  mount: MountEntry,
  walked: number,
): PathSpec[] {
  return virtuals.map((v) => {
    const prefix = rstripSlash(mountOf(registry, v, mount).prefix)
    const base = PathSpec.fromStrPath(v, mountKey(v, prefix))
    return new PathSpec({
      virtual: base.virtual,
      directory: base.directory,
      resourcePath: base.resourcePath,
      rawPath: spellMatch(unmarkGlobs(item.rawPath), v, walked),
    })
  })
}

// Union a backend's matches with the namespace-owed ones. Sorted, because
// bash sorts a pathname expansion and the two sources are enumerated
// separately. The backend is asked with a directory-shaped spec, which
// answers with matches alone, so "nothing matched" arrives as an empty list
// and the caller reinstates the literal only when the union is empty too.
//
// A match is a child of the directory it was globbed in, so a spec that is
// the directory itself is not one. The shared resolver never answers a
// dir-shaped ask that way, but `glob` is a public hook and a resource
// reinstating the literal on its own would hand back the spec it was given.
// Unlike the word comparison this replaces, the test cannot discard a real
// match: a match is strictly longer than the directory holding it, while a
// word can be spelled exactly like one. `directory` arrives with its marks
// off, because a match is a real path a backend listed: a glob character
// quoted in the directory's name is a character of it, and the marked
// spelling would match no match at all.
function mergeNamespace(
  matches: readonly PathSpec[],
  extra: readonly string[],
  directory: string,
  registry: MountRegistry,
  mount: MountEntry,
): PathSpec[] {
  const specs = matches.filter((m) => m.virtual.startsWith(directory) && m.virtual !== directory)
  const seen = new Set(specs.map((m) => m.virtual))
  for (const virtual of extra) {
    if (seen.has(virtual)) continue
    seen.add(virtual)
    // A nested mount root belongs to the mount it opens, not to the one
    // being listed, so it is keyed against its own backend.
    const owner = rstripSlash(mountOf(registry, virtual, mount).prefix)
    specs.push(PathSpec.fromStrPath(virtual, mountKey(virtual, owner)))
  }
  return specs.sort((a, b) => compareCodePoints(a.virtual, b.virtual))
}

// One descent step: the owning backend's matches plus the namespace's.
// The walk can cross into a nested mount, because a mid-path segment may
// match a mount root, so the backend asked is the one owning that parent
// rather than the one owning the typed word. It can equally descend
// through a symlinked directory, so the parent is resolved through the
// namespace first and the matches are spelled back under the name that
// was typed.
async function levelMatches(
  registry: MountRegistry,
  mount: MountEntry,
  links: NamespaceLinks | null,
  dirVirtual: string,
  seg: string,
): Promise<string[]> {
  const real = listingDir(links, dirVirtual)
  const owner = mountOf(registry, real, mount)
  const prefix = rstripSlash(owner.prefix)
  const out: string[] = []
  if (owner.resource.glob !== undefined) {
    const spec = new PathSpec({
      virtual: real,
      directory: real,
      resourcePath: mountKey(real, prefix),
      pattern: seg,
      resolved: false,
    })
    try {
      const matches = await owner.resource.glob([spec], prefix)
      // A descent step yields children, so a match that is the parent
      // itself is not one. A backend asked to list a path that is really
      // a file answers with that file, which walked back out as a
      // doubled segment (`/base/f*/f1` -> `/base/base/f1`); bash keeps
      // the literal because a file is not a directory to descend into.
      const base = `${rstripSlash(real)}/`
      for (const m of matches) {
        if (m.virtual.startsWith(base)) out.push(m.virtual)
      }
    } catch (err) {
      // fs-coded failures mean this parent is not a listable directory
      // (bash skips it); anything else is a real bug and propagates. A
      // nested mount root or a link under it is still real.
      if ((err as { code?: string }).code === undefined) throw err
    }
  }
  out.push(...namespaceChildren(registry, links, real, seg))
  return real === dirVirtual ? out : respell(out, dirVirtual)
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
  mount: MountEntry,
  registry: MountRegistry,
  links: NamespaceLinks | null,
): Promise<PathSpec[]> {
  const segments = stripSlash(item.virtual).split('/')
  const first = segments.findIndex((seg) => hasGlobChars(seg))
  const walked = segments.length - first
  // The head above the first glob segment is a real directory, so a glob
  // character quoted inside it is part of the name to list.
  let level: string[] = [unmarkGlobs('/' + segments.slice(0, first).join('/'))]
  for (const seg of segments.slice(first)) {
    const gathered: string[] = []
    for (const parent of level) {
      gathered.push(...(await levelMatches(registry, mount, links, `${rstripSlash(parent)}/`, seg)))
    }
    // bash sorts a pathname expansion, and the backend and the namespace
    // are enumerated separately, so the union is ordered here.
    level = [...new Set(gathered)].sort(compareCodePoints)
    if (level.length === 0) return []
  }
  return toSpecs(level, item, registry, mount, walked)
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
  // A mark is one character wide, so the directory's marked and literal
  // spellings are the same length and this cut holds either way; only the
  // head that is carried over has to lose its marks.
  if (!match.virtual.startsWith(unmarkGlobs(item.directory))) return match
  const rawDir = unmarkGlobs(item.rawPath.slice(0, item.rawPath.lastIndexOf('/') + 1))
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
  noglob = false,
  links: NamespaceLinks | null = null,
): Promise<(string | PathSpec)[]> {
  // set -f: skip resolution entirely, so every glob word keeps its
  // literal spelling like a zero-match glob.
  if (noglob) return classified.map((item) => literalWord(item))
  const result: (string | PathSpec)[] = []
  for (const item of classified) {
    if (item instanceof PathSpec && item.pattern !== null) {
      // A pattern word no mount owns stays the literal word like a
      // zero-match glob.
      const mount = registry.tryMountFor(item.virtual)
      if (mount === null) {
        result.push(item)
        continue
      }
      const prefix = rstripSlash(mount.prefix)
      // A resource with no glob of its own can still hold a nested mount
      // root or a link under the globbed directory; with nothing for the
      // namespace to add it keeps the untouched pass-through it had.
      const midPath = hasGlobChars(item.directory)
      // The parent directory is a real directory to list, so a glob
      // character quoted inside it is part of its name.
      const directory = unmarkGlobs(item.directory)
      // The parent is a symlink, so the backend holding the typed path
      // has nothing to list and levelMatches has to follow it first.
      const linked = !midPath && listingDir(links, directory) !== directory
      const extra =
        midPath || linked ? [] : namespaceChildren(registry, links, directory, item.pattern)
      if (!linked && mount.resource.glob === undefined && extra.length === 0) {
        result.push(item)
        continue
      }
      const withPrefix = new PathSpec({
        virtual: item.virtual,
        directory: item.directory,
        pattern: item.pattern,
        resolved: item.resolved,
        resourcePath: mountKey(item.virtual, prefix),
        rawPath: item.rawPath,
      })
      try {
        let resolved: PathSpec[]
        if (midPath) {
          resolved = await walkSegments(withPrefix, mount, registry, links)
        } else if (linked) {
          const found = await levelMatches(registry, mount, links, directory, item.pattern)
          resolved = toSpecs(
            [...new Set(found)].sort(compareCodePoints),
            withPrefix,
            registry,
            mount,
            1,
          )
        } else {
          // Asked with the word, a backend that matched nothing answers
          // with the word (nullglob off), which is byte-identical to a
          // real match on a file named like the pattern -- `*a.txt` next
          // to `xa.txt` lost its first match to that ambiguity. The
          // directory-shaped spec has no literal to reinstate, so an
          // empty list means no match and every spec returned is one.
          const own =
            mount.resource.glob !== undefined
              ? await mount.resource.glob([withPrefix.dir], prefix)
              : []
          resolved = mergeNamespace(own, extra, directory, registry, mount)
        }
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
  // Resolution is over, so the quoting the marks carried has done its
  // work: what leaves is the word after quote removal, matched or not.
  return result.map((item) => literalWord(item))
}

// The fixed directory above a word's first glob segment.
function globHead(spec: PathSpec): string {
  const fixed: string[] = []
  for (const seg of spec.virtual.split('/')) {
    if (hasGlobChars(seg)) break
    fixed.push(seg)
  }
  return fixed.join('/') + '/'
}

/**
 * Expand glob words that could match across a mount boundary.
 *
 * A glob operand is normally left for the owning backend to resolve,
 * which is how a prefix store pushes the listing down. That only holds
 * while every match belongs to that backend: a nested mount's root is a
 * child of the directory but its keys live in another resource, so the
 * backend answers "no such file" for a name its own listing shows. When
 * the glob's fixed head holds a child mount, the word is expanded here
 * instead, before routing, so the matches route per mount exactly as the
 * same paths typed by hand already do. Every other glob is left
 * untouched, so pushdown is unaffected.
 */
export async function expandBoundaryGlobs(
  parts: readonly (string | PathSpec)[],
  registry: MountRegistry,
  links: NamespaceLinks | null,
): Promise<(string | PathSpec)[]> {
  const prefixes = registry.mountPrefixes()
  const spans = (p: string | PathSpec): boolean =>
    p instanceof PathSpec && p.pattern !== null && childMountNames(prefixes, globHead(p)).length > 0
  if (!parts.some(spans)) return [...parts]
  const out: (string | PathSpec)[] = []
  for (const item of parts) {
    if (spans(item)) {
      out.push(...(await resolveGlobs([item], registry, false, links)))
    } else {
      out.push(item)
    }
  }
  return out
}
