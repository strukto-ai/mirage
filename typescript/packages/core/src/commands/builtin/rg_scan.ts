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

import type { FileStat, PathSpec } from '../../types.ts'
import { FileType } from '../../types.ts'
import { fsStrerror, isWalkError } from '../../errors/fs.ts'
import { classify } from '../../errors/classify.ts'
import { posixErrno } from '../../errors/posix.ts'
import { gnuBasename, respellOne } from '../../utils/path.ts'
import { getExtension } from '../../utils/filetype.ts'
import { BINARY_EXTENSIONS } from './constants.ts'
import type { FileTypes } from './rg_filetypes.ts'
import { type Overrides, Verdict, walkCandidate } from './rg_glob.ts'
import type { LinkResolver } from './utils/links.ts'
import type { AsyncReaddirFn, AsyncStatFn } from './utils/types.ts'
import { rstripSlash } from '../../utils/slash.ts'

/**
 * What ripgrep's walker keeps below a directory operand. The ignore crate's
 * order: a `-g` glob decides first and outranks everything after it, then
 * `-t`/`-T`, and a dot entry is left out unless a glob or a `-t` type kept
 * it or `--hidden` is on. A file is also left out past `--max-filesize`,
 * and for a binary extension unless `-a`/`--binary` asked for it. A name on
 * the line is never filtered: only walked entries are. `maxDepth` is the
 * deepest entry kept (1 is the operand's own children).
 */
export class WalkFilter {
  constructor(
    readonly overrides: Overrides,
    readonly types: FileTypes,
    readonly hidden: boolean,
    readonly maxDepth: number | null,
    readonly maxFilesize: number | null,
    readonly binary: boolean,
  ) {}

  // Whether a walked entry is kept (a directory: descended). `candidate`
  // is its path as the globs match it, `name` its file name.
  admits(candidate: string, name: string, isDir: boolean): boolean {
    const verdict = this.overrides.verdict(candidate, isDir)
    if (verdict === Verdict.IGNORE) return false
    if (verdict === Verdict.WHITELIST) return true
    const typed = this.types.verdict(name, isDir)
    if (typed === Verdict.IGNORE) return false
    return typed === Verdict.WHITELIST || this.hidden || !name.startsWith('.')
  }

  // Whether a walked file is searched, its stat read when the walk has one.
  admitsFile(candidate: string, name: string, stat: FileStat | null): boolean {
    if (!this.admits(candidate, name, false)) return false
    const size = stat?.size ?? null
    if (this.maxFilesize !== null && size !== null && size > this.maxFilesize) return false
    return this.binary || !BINARY_EXTENSIONS.has(getExtension(name) ?? '')
  }
}

/**
 * One input rg searches: its virtual path (`-` for stdin), the path rg
 * prints for it, its stat when the walk read one (the time sorts read it),
 * the operand itself when it was named on the line, which a stream read
 * takes, and the dispatcher a file the walk reached through a link is read
 * through, since the link may lead onto a mount the operand's backend
 * cannot read.
 */
export interface Haystack {
  virtual: string
  shown: string
  stat: FileStat | null
  spec: PathSpec | null
  resolver: LinkResolver | null
}

function errorText(err: unknown): string {
  return fsStrerror(err) ?? (err instanceof Error ? err.message : String(err))
}

/**
 * An OS error the way ripgrep's Rust `io::Error` displays it: the strerror,
 * then the Linux errno it came from (`No such file or directory (os error
 * 2)`). A failure the vocabulary cannot number keeps its words alone.
 * Mirrors Python's os_error_text.
 */
export function osErrorText(err: unknown): string {
  const text = errorText(err)
  const condition = classify(err)
  return condition === null ? text : `${text} (os error ${String(posixErrno(condition))})`
}

// ripgrep's line for a path its walker could not stat or list, worded by the
// walker it ran. The sequential one names the path a second time; the
// parallel one, which it runs for more than one path or a directory unless
// -j1 or a sort holds it to one thread, names it once (ripgrep 14.1.1).
// Mirrors Python's walk_error_line.
export function walkErrorLine(shown: string, err: unknown, parallel = false): string {
  if (parallel) return `rg: ${shown}: ${osErrorText(err)}`
  return `rg: ${shown}: IO error for operation on ${shown}: ${osErrorText(err)}`
}

// ripgrep's line for a link -L found leading back into the walk: the link,
// then the directory above it that it names, nearest first, each as the
// walker spells it (ripgrep 14.1.1). Mirrors Python's loop_error_line.
export function loopErrorLine(shown: string, ancestor: string): string {
  return `rg: File system loop found: ${shown} points to an ancestor ${ancestor}`
}

// ripgrep's line for a file its searcher could not open or read: the bare
// I/O error, without the walker's preamble (ripgrep 14.1.1). Mirrors
// Python's open_error_line.
export function openErrorLine(shown: string, err: unknown): string {
  return `rg: ${shown}: ${osErrorText(err)}`
}

// An entry's path without the folder mark some backends append.
function entryName(entry: string): string {
  return rstripSlash(entry)
}

function byName(a: string, b: string): number {
  const x = entryName(a)
  const y = entryName(b)
  return x < y ? -1 : x > y ? 1 : 0
}

/**
 * --one-file-system's test: whether a directory lies on another mount than
 * the operand's. A mount is mirage's filesystem boundary, which a directory
 * crosses by being a mount root and a link by leading onto another mount.
 * `path` has every link resolved. Mirrors Python's on_other_mount.
 */
export function onOtherMount(
  rootOf: (path: string) => string,
  home: string,
  path: string,
): boolean {
  return rootOf(path) !== home
}

/**
 * The files a walk of one directory operand searches, in walk order. `root`
 * is the operand's virtual path and `shownRoot` the operand as typed, which
 * every printed path below it starts with (empty for the implicit cwd, whose
 * matches print bare while the walker names `./x`); `cwd` is the root the
 * globs are matched from. `sortByName` is --sort path, each directory's
 * entries in name order rather than the backend's. `boundary` is
 * --one-file-system's test for a directory on another mount than the
 * operand's, which the walk does not enter, or null to enter everything.
 * `resolver` is the namespace's links and the dispatcher past them, null outside a
 * workspace, where no link can stand.
 *
 * A link the walk meets is skipped, as ripgrep skips one, unless `follow`
 * (-L) says to walk through it: then it stands for what it leads to, a
 * directory descended and a file searched under the link's own name, and
 * one that dangles, loops or leads back to a directory above it is reported
 * in ripgrep's words and skipped. Mirrors Python's walk_haystacks.
 */
export async function* walkHaystacks(
  readdirFn: AsyncReaddirFn,
  statFn: AsyncStatFn,
  root: string,
  shownRoot: string,
  cwd: string,
  walk: WalkFilter,
  sortByName: boolean,
  warnings: string[] | null,
  boundary: ((path: string) => boolean) | null = null,
  resolver: LinkResolver | null = null,
  follow = false,
  parallel = false,
): AsyncGenerator<Haystack> {
  const walker = new Walker(
    readdirFn,
    statFn,
    cwd,
    walk,
    sortByName,
    warnings,
    boundary,
    resolver,
    follow,
    shownRoot === '',
    parallel,
  )
  yield* walker.below(root, root, shownRoot, 0, [[root, walker.named(shownRoot)]], false)
}

// One directory the walk has listed, as its link-resolved path and the
// walker's name for it.
type Level = readonly [real: string, named: string]

// What one operand's walk reads with and keeps, for every level. Mirrors
// Python's _Walker.
class Walker {
  constructor(
    readonly readdirFn: AsyncReaddirFn,
    readonly statFn: AsyncStatFn,
    readonly cwd: string,
    readonly walk: WalkFilter,
    readonly sortByName: boolean,
    readonly warnings: string[] | null,
    readonly boundary: ((path: string) => boolean) | null,
    readonly resolver: LinkResolver | null,
    readonly follow: boolean,
    readonly implicit: boolean,
    readonly parallel: boolean,
  ) {}

  // A path as the walker names it in a warning. Matches print the implicit
  // cwd's paths bare, but the walker's own errors name the path it walked,
  // which starts `./` (ripgrep 14.1.1).
  named(shown: string): string {
    if (!this.implicit) return shown
    return shown !== '' ? `./${shown}` : './'
  }

  warn(line: string): void {
    this.warnings?.push(line)
  }

  // Whether a link stands at a walked entry.
  isLink(virtual: string): boolean {
    return this.resolver !== null && this.resolver.links.statAt(virtual) !== null
  }

  /**
   * The files under one directory the walk lists. `here` has every link
   * resolved; `base` is the path its entries are spelled from (the operand,
   * or the link-resolved directory the walk last reached through a link)
   * and `shownBase` that path as printed. `chain` is `here` and every
   * directory above it to the operand, nearest first: what a link leading
   * back into the walk is caught against. `linked` says the walk reached
   * `here` through a link, so it reads through the dispatcher rather than the
   * operand's backend.
   */
  async *below(
    here: string,
    base: string,
    shownBase: string,
    depth: number,
    chain: readonly Level[],
    linked: boolean,
  ): AsyncGenerator<Haystack> {
    if (this.walk.maxDepth !== null && depth >= this.walk.maxDepth) return
    const resolver = linked ? this.resolver : null
    let entries: string[]
    try {
      entries = resolver !== null ? await resolver.readdir(here) : await this.readdirFn(here)
    } catch (err) {
      if (!isWalkError(err)) throw err
      this.warn(walkErrorLine(chain[0]?.[1] ?? here, err, this.parallel))
      return
    }
    if (this.follow && this.resolver !== null) {
      const listed = new Set(entries.map(entryName))
      entries = [...entries, ...this.resolver.children(here).filter((link) => !listed.has(link))]
    }
    if (this.sortByName) entries = [...entries].sort(byName)
    for (const entry of entries) {
      // box/dropbox readdir marks folders with a trailing slash.
      const child = entryName(entry) || entry
      const shown = respellOne(child, base, shownBase)
      if (this.isLink(child)) {
        if (this.follow) yield* this.through(child, shown, depth, chain)
        continue
      }
      let s: FileStat
      try {
        s = resolver !== null ? await resolver.stat(entry) : await this.statFn(entry)
      } catch (err) {
        if (!isWalkError(err)) throw err
        this.warn(walkErrorLine(this.named(shown), err, this.parallel))
        continue
      }
      const name = gnuBasename(child)
      const candidate = walkCandidate(shown, this.cwd)
      if (s.type === FileType.DIRECTORY) {
        if (this.boundary?.(child) === true) continue
        if (this.walk.admits(candidate, name, true)) {
          yield* this.below(
            child,
            base,
            shownBase,
            depth + 1,
            [[child, this.named(shown)], ...chain],
            linked,
          )
        }
      } else if (s.type === FileType.FILE && this.walk.admitsFile(candidate, name, s)) {
        yield { virtual: child, shown, stat: s, spec: null, resolver }
      }
    }
  }

  /**
   * What -L walks in place of one link. The ignore crate's order: the link
   * is followed first, so one that dangles or loops is reported whatever the
   * filters would have said of its name, then a directory it leads to is
   * checked against the chain above it, and only then do the filters decide.
   */
  async *through(
    link: string,
    shown: string,
    depth: number,
    chain: readonly Level[],
  ): AsyncGenerator<Haystack> {
    const resolver = this.resolver
    if (resolver === null) return
    const named = this.named(shown)
    let target: string
    let s: FileStat
    try {
      target = resolver.target(link)
      s = await resolver.stat(target)
    } catch (err) {
      if (!isWalkError(err)) throw err
      this.warn(walkErrorLine(named, err, this.parallel))
      return
    }
    const name = gnuBasename(link)
    const candidate = walkCandidate(shown, this.cwd)
    if (s.type === FileType.DIRECTORY) {
      const above = chain.find(([real]) => real === target)
      if (above !== undefined) {
        this.warn(loopErrorLine(named, above[1]))
        return
      }
      if (this.boundary?.(target) === true) return
      if (this.walk.admits(candidate, name, true)) {
        yield* this.below(target, target, shown, depth + 1, [[target, named], ...chain], true)
      }
    } else if (s.type === FileType.FILE && this.walk.admitsFile(candidate, name, s)) {
      yield { virtual: target, shown, stat: s, spec: null, resolver }
    }
  }
}

/**
 * The candidates a walk of `scopes` would have searched. A search push-down
 * narrows a directory search to candidate files and hands them on as
 * operands of their own, which ripgrep never filters, so the walk's filters
 * are applied here instead, to each directory on the way down (a directory
 * the walk would not descend hides everything below it) and to the file
 * itself, and -d counts the depth below the candidate's (longest-matching)
 * scope.
 */
export function walkCandidates(
  candidates: PathSpec[],
  scopes: readonly PathSpec[],
  walk: WalkFilter,
  cwd: string,
): PathSpec[] {
  const kept: PathSpec[] = []
  for (const p of candidates) {
    let base = ''
    let raw = ''
    let best = -1
    for (const scope of scopes) {
      const root = rstripSlash(scope.virtual)
      if (root.length > best && (p.virtual === root || p.virtual.startsWith(root + '/'))) {
        base = root
        raw = scope.rawPath
        best = root.length
      }
    }
    if (best < 0 || p.virtual === base) {
      kept.push(p)
      continue
    }
    const segments = p.virtual.slice(base.length + 1).split('/')
    if (walk.maxDepth !== null && segments.length > walk.maxDepth) continue
    let admitted = true
    for (let i = 0; i < segments.length - 1; i++) {
      const below = base + '/' + segments.slice(0, i + 1).join('/')
      const shown = respellOne(below, base, raw)
      if (!walk.admits(walkCandidate(shown, cwd), segments[i] ?? '', true)) {
        admitted = false
        break
      }
    }
    const shown = respellOne(p.virtual, base, raw)
    const last = segments[segments.length - 1] ?? ''
    if (admitted && walk.admitsFile(walkCandidate(shown, cwd), last, null)) kept.push(p)
  }
  return kept
}
