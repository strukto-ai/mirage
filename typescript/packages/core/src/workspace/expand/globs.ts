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
import { sessionVisibility } from '../../context/session_context.ts'
import type { NamespaceLinks } from '../../ops/config.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { isFsError } from '../../utils/errors.ts'
import type { MountEntry } from '../mount/mount.ts'
import type { MountRegistry } from '../mount/registry.ts'
import {
  globNameMatches,
  globPattern,
  hasGlob as hasGlobChars,
  literalWord,
  spellMatch,
  unmarkGlobs,
} from '../../utils/glob_walk.ts'
import { CycleError, parent } from '../../utils/path.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { DiscardSignal, ExitSignal } from '../../shell/errors.ts'
import { SHOPT_DEFAULTS } from '../../shell/constants.ts'
import type { SessionState } from '../session/session.ts'
import { encodeText } from '../../shell/bytes.ts'

// How deep a `**` descends. bash has no cap, but every level here is
// one listing per directory, so an accidental `**` over a large tree is
// bounded rather than open-ended.
const GLOBSTAR_MAX_DEPTH = 32

// The `shopt` options pathname expansion reads. `dotglob` is applied
// inside the backend glob (`globNameMatches`), so it does not travel
// here.
export interface GlobOptions {
  nullglob: boolean
  failglob: boolean
  globstar: boolean
}

/** Whether a mount command's glob must expand here rather than push
 * down: the backend knows none of these. */
export function globNeedsShell(opts: GlobOptions): boolean {
  return opts.nullglob || opts.failglob || opts.globstar
}

export function globOptions(session: SessionState): GlobOptions {
  return {
    nullglob: session.shopts.nullglob ?? SHOPT_DEFAULTS.get('nullglob') ?? false,
    failglob: session.shopts.failglob ?? SHOPT_DEFAULTS.get('failglob') ?? false,
    globstar: session.shopts.globstar ?? SHOPT_DEFAULTS.get('globstar') ?? false,
  }
}

// Virtual paths a directory owes the namespace, matching a segment.
// Child mounts and symlinks are namespace state no backend can see, so a
// glob that stops at one backend misses both: a nested mount's keys live
// in another VFS, and no VFS stores a link. This is the union
// mergeReaddir already applies to a listing, filtered by the glob segment
// with the same matcher backends use, and filtered by the bound session's
// visibility, as the backend's own matches are, so a scoped session never
// learns an ungranted mount's name from an expansion.
function namespaceChildren(
  registry: MountRegistry,
  links: NamespaceLinks | null,
  directory: string,
  pattern: string,
): string[] {
  const base = rstripSlash(directory)
  const matcher = globPattern(pattern)
  return namespaceNames(sessionVisibility(), registry.mountPrefixes(), links, directory)
    .filter((name) => globNameMatches(name, matcher))
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
      vfsPath: base.vfsPath,
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
// dir-shaped ask that way, but `glob` is a public hook and a VFS
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
  await owner.ensureReady()
  const prefix = rstripSlash(owner.prefix)
  const out: string[] = []
  if (owner.hasOp('glob')) {
    const spec = new PathSpec({
      virtual: real,
      directory: real,
      vfsPath: mountKey(real, prefix),
      pattern: seg,
      resolved: false,
    })
    try {
      const matches = await owner.expandGlob([spec], prefix)
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
    vfsPath: match.vfsPath,
    rawPath: spelled,
  })
}

function joinSpelling(head: string, name: string): string {
  if (head === '') return name
  return `${rstripSlash(head)}/${name}`
}

async function descend(
  registry: MountRegistry,
  mount: MountEntry,
  links: NamespaceLinks | null,
  parent: string,
  spelled: string,
  depth: number,
): Promise<[string, string][]> {
  if (depth >= GLOBSTAR_MAX_DEPTH) return []
  const out: [string, string][] = []
  const children = [...new Set(await levelMatches(registry, mount, links, `${parent}/`, '*'))].sort(
    compareCodePoints,
  )
  for (const child of children) {
    const childSpelled = joinSpelling(spelled, child.split('/').pop() ?? '')
    out.push([child, childSpelled])
    out.push(...(await descend(registry, mount, links, child, childSpelled, depth + 1)))
  }
  return out
}

// Expand a word level by level, one segment at a time. A glob in a
// non-final segment (`s*/x.txt`) cannot resolve in one listing, so each
// segment is matched against its (already expanded) parents with the owning
// backend's own single-level glob, and an intermediate match that cannot be
// listed is skipped, as in bash's directories-only descent. The walk starts
// at the first glob or dot segment: a `.` or `..` applies to each parent
// that is a directory, `..` climbing from where a link leads, which is the
// kernel's walk of `name/..` that bash's opendir makes, so a missing or
// plain-file name in front of one matches nothing. Under `globstar` a `**` segment matches
// zero or more directory levels: the parent itself (spelled with a
// trailing slash when the word has a fixed head, `d/**` -> `d/`, and left
// out for a bare `**`) plus every descendant. The spelling is carried level
// by level, the typed head plus each segment as matched. Mirrors Python's
// _walk.
async function walk(
  item: PathSpec,
  mount: MountEntry,
  registry: MountRegistry,
  links: NamespaceLinks | null,
  globstar: boolean,
): Promise<PathSpec[]> {
  const typed = stripSlash(item.dotted ?? item.virtual).split('/')
  const first = typed.findIndex((seg) => hasGlobChars(seg) || seg === '.' || seg === '..')
  const raw = rstripSlash(unmarkGlobs(item.rawPath)).split('/')
  let spelledHead = raw.slice(0, raw.length - (typed.length - first)).join('/')
  if (item.rawPath.startsWith('/') && spelledHead === '') spelledHead = '/'
  // The head above the first glob or dot segment is a real directory, so a
  // glob character quoted inside it is part of the name to list.
  const head = unmarkGlobs('/' + typed.slice(0, first).join('/'))
  let level: [string, string, boolean][] = [[head, spelledHead, false]]
  for (const seg of typed.slice(first)) {
    const gathered: [string, string, boolean][] = []
    for (const [dir, spelled] of level) {
      if (seg === '.' || seg === '..') {
        if (await isDirectory(registry, mount, links, dir)) {
          const real = links !== null ? links.follow(dir) : dir
          gathered.push([seg === '..' ? parent(real) : dir, joinSpelling(spelled, seg), false])
        }
      } else if (globstar && seg === '**') {
        gathered.push([dir, spelled, true])
        for (const [v, sp] of await descend(registry, mount, links, dir, spelled, 0)) {
          gathered.push([v, sp, false])
        }
      } else {
        for (const child of await levelMatches(
          registry,
          mount,
          links,
          `${rstripSlash(dir)}/`,
          seg,
        )) {
          gathered.push([child, joinSpelling(spelled, child.split('/').pop() ?? ''), false])
        }
      }
    }
    // bash sorts a pathname expansion, and the backend and the namespace
    // are enumerated separately, so the union is ordered here, one entry
    // per spelling.
    const seen = new Map<string, [string, string, boolean]>()
    for (const entry of gathered) if (!seen.has(entry[1])) seen.set(entry[1], entry)
    level = [...seen.values()].sort((a, b) => compareCodePoints(a[1], b[1]))
    if (level.length === 0) return []
  }
  return level
    .filter(([, sp, isSelf]) => sp !== '' || !isSelf)
    .map(([v, sp, isSelf]) => {
      const base = PathSpec.fromStrPath(
        v,
        mountKey(v, rstripSlash(mountOf(registry, v, mount).prefix)),
      )
      return new PathSpec({
        virtual: base.virtual,
        directory: base.directory,
        vfsPath: base.vfsPath,
        rawPath: isSelf ? `${rstripSlash(sp)}/` : sp,
      })
    })
}

// Whether a match is a directory, the way a trailing slash asks. bash keeps
// a directory or a symlink to one and drops a regular file or a broken link
// (bash 5.2, `*/`). A nested mount root is a directory by construction;
// anything else is asked of the mount that owns the link-resolved path, one
// stat per match. That mount is readied first, as levelMatches readies one
// before listing it, because a link can point into a mount nothing has
// touched yet. The mount's op table supplies stat; an unclassified match is dropped.
async function isDirectory(
  registry: MountRegistry,
  mount: MountEntry,
  links: NamespaceLinks | null,
  virtual: string,
): Promise<boolean> {
  let real = virtual
  if (links !== null) {
    try {
      real = links.follow(virtual)
    } catch (err) {
      if (err instanceof CycleError) return false
      throw err
    }
  }
  const owner = mountOf(registry, real, mount)
  const prefix = rstripSlash(owner.prefix)
  if (rstripSlash(real) === prefix) return true
  let row: unknown
  try {
    await owner.ensureReady()
    row =
      registry.opStat === null
        ? await owner.executeOp('stat', real)
        : await registry.opStat(owner, PathSpec.fromStrPath(real, mountKey(real, prefix)))
  } catch (err) {
    if (isFsError(err)) return false
    throw err
  }
  return row instanceof FileStat && row.type === FileType.DIRECTORY
}

function withTrailingSlash(spec: PathSpec): PathSpec {
  return new PathSpec({
    virtual: spec.virtual,
    directory: spec.directory,
    pattern: spec.pattern,
    resolved: spec.resolved,
    vfsPath: spec.vfsPath,
    rawPath: `${spec.rawPath}/`,
  })
}

function hasGlobstarSegment(item: PathSpec): boolean {
  return unmarkGlobs(item.virtual).split('/').includes('**')
}

export async function resolveGlobs(
  classified: readonly (string | PathSpec)[],
  registry: MountRegistry,
  noglob = false,
  links: NamespaceLinks | null = null,
  options: GlobOptions | null = null,
): Promise<(string | PathSpec)[]> {
  // set -f: skip resolution entirely, so every glob word keeps its
  // literal spelling like a zero-match glob.
  if (noglob) return classified.map((item) => literalWord(item))
  const opts: GlobOptions = options ?? { nullglob: false, failglob: false, globstar: false }
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
      // A VFS with no glob of its own can still hold a nested mount
      // root or a link under the globbed directory; with nothing for the
      // namespace to add it keeps the untouched pass-through it had.
      const midPath = item.dotted !== null || hasGlobChars(item.directory)
      // The parent directory is a real directory to list, so a glob
      // character quoted inside it is part of its name.
      const directory = unmarkGlobs(item.directory)
      // The parent is a symlink, so the backend holding the typed path
      // has nothing to list and levelMatches has to follow it first.
      const linked = !midPath && listingDir(links, directory) !== directory
      const extra =
        midPath || linked ? [] : namespaceChildren(registry, links, directory, item.pattern)
      if (!linked && !mount.hasOp('glob') && extra.length === 0) {
        result.push(item)
        continue
      }
      // A trailing slash asks for directories only, and every match keeps
      // one (`*/` -> `sub/`, and so does `*//`). The slash is not part of
      // the spelling to rebuild, so it comes off the word here and goes
      // back on each match; the literal answer to a zero-match glob is
      // still the word as typed. normpath already dropped it from
      // `virtual`, which is what tells a typed word from a
      // directory-shaped spec (#1065).
      const dirsOnly = item.rawPath.endsWith('/') && item.rawPath !== item.virtual
      const withPrefix = new PathSpec({
        virtual: item.virtual,
        directory: item.directory,
        pattern: item.pattern,
        resolved: item.resolved,
        vfsPath: mountKey(item.virtual, prefix),
        rawPath: dirsOnly ? rstripSlash(item.rawPath) : item.rawPath,
        dotted: item.dotted,
      })
      const typed = dirsOnly
        ? new PathSpec({
            virtual: withPrefix.virtual,
            directory: withPrefix.directory,
            pattern: withPrefix.pattern,
            resolved: withPrefix.resolved,
            vfsPath: withPrefix.vfsPath,
            rawPath: item.rawPath,
          })
        : withPrefix
      await mount.ensureReady()
      try {
        let resolved: PathSpec[]
        if (midPath || (opts.globstar && hasGlobstarSegment(withPrefix))) {
          resolved = await walk(withPrefix, mount, registry, links, opts.globstar)
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
          const own = await mount.expandGlob([withPrefix.dir], prefix)
          resolved = mergeNamespace(own, extra, directory, registry, mount)
        }
        if (dirsOnly) {
          const kept: PathSpec[] = []
          for (const p of resolved) {
            if (await isDirectory(registry, mount, links, p.virtual)) kept.push(p)
          }
          resolved = kept
        }
        if (resolved.length === 0) {
          // bash's three answers to a zero-match glob: the literal word
          // (default), nothing at all under nullglob, and a fatal
          // expansion error under failglob. The literal is resolved, or the
          // command's backend would glob it again over the simplified path
          // (`missing/../*` as `*`); the pattern stays, so a push-down still
          // reads it as no entity name.
          if (opts.failglob) {
            const word = unmarkGlobs(typed.rawPath)
            throw new DiscardSignal(encodeText(`bash: no match: ${word}\n`))
          }
          if (!opts.nullglob) {
            result.push(
              new PathSpec({
                virtual: item.virtual,
                directory: item.directory,
                vfsPath: item.vfsPath,
                rawPath: item.rawPath,
                dotted: item.dotted,
                walkError: item.walkError,
                pattern: item.pattern,
                resolved: true,
              }),
            )
          }
        } else {
          for (const p of resolved) {
            const spelled = matchRaw(withPrefix, p)
            result.push(dirsOnly ? withTrailingSlash(spelled) : spelled)
          }
        }
      } catch (err) {
        // A failglob refusal is fatal and propagates; an ordinary
        // resolution failure keeps the literal word.
        if (err instanceof ExitSignal) throw err
        result.push(typed)
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
 * child of the directory but its keys live in another VFS, so the
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
  const vis = sessionVisibility()
  const spans = (p: string | PathSpec): boolean =>
    p instanceof PathSpec &&
    p.pattern !== null &&
    childMountNames(vis, prefixes, globHead(p)).length > 0
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
