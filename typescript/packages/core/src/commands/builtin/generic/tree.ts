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

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { LINK_TARGET_KEY, FileType, PathSpec, type FileStat } from '../../../types.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { enoent, isMissError, isWalkError } from '../../../errors/fs.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import type { MountView } from '../../../view/types.ts'
import { fnmatch } from '../../../utils/fnmatch.ts'
import { formatRecords } from '../utils/output.ts'
import { compareCodePoints } from '../../../utils/sort.ts'
import { linksOf, mountsOf } from '../utils/links.ts'

const UNOPENABLE_MARK = '  [error opening dir]'

interface TreeFlags {
  readonly maxDepth: number | null
  readonly showHidden: boolean
  readonly ignorePattern: string | null
  readonly dirsOnly: boolean
  readonly matchPattern: string | null
  readonly oneFileSystem: boolean
}

function parseFlags(bag: Record<string, FlagValue>): TreeFlags {
  const fl = new FlagView(bag, specOf('tree'))
  const depthRaw = fl.asStr('L') ?? null
  return {
    maxDepth: depthRaw === null ? null : Number.parseInt(depthRaw, 10),
    showHidden: fl.asBool('a'),
    ignorePattern: fl.asStr('args_I') ?? null,
    dirsOnly: fl.asBool('d'),
    matchPattern: fl.asStr('P') ?? null,
    oneFileSystem: fl.asBool('x'),
  }
}

interface TreeOpts {
  showHidden: boolean
  maxDepth: number | null
  ignorePattern: string | null
  dirsOnly: boolean
  matchPattern: string | null
  // Where the boundaries are, and the dispatcher-backed pair that reads
  // past one. Unlike find and du, tree's output is a single document
  // (one root line, one drawing, one count), so a per-mount run cannot
  // be concatenated: it would print two of each. The boundary is crossed
  // here instead, the way real tree crosses one.
  mounts: MountView | null
  crossReaddir: ((p: PathSpec) => Promise<string[]>) | null
  crossStat: ((p: PathSpec) => Promise<FileStat>) | null
  // What a drawn link leads to, from the namespace's symlink facts.
  targetStat: ((path: string) => Promise<FileStat | null>) | null
}

// The mount roots mounted directly on this directory. A mount point need
// not exist in the parent backend at all, and when it does the parent
// lists a directory whose contents belong to somebody else. Either way
// the name has to come from the mount table, as `ls` injects it.
//
// Session-filtered, because a crossing entry is drawn from the mount
// table alone: its row is synthesized as a directory without asking any
// backend, so the dispatcher never gets the chance to refuse it and an
// hidden mount's name would reach the drawing. `ls` filters the same
// fact through `childMountNames`. `tree` names the boundary rather than
// avoiding it, so it reads the visible list; `du` reads the other one
// from the same view, because there a hidden mount still shadows the
// parent's keys and its prefix has to stay.
function childMounts(mounts: MountView | null, directory: string): string[] {
  if (mounts === null) return []
  const base = rstripSlash(directory) || '/'
  return mounts.visibleDescendants(directory).filter((root) => {
    const parent = root.slice(0, root.lastIndexOf('/')) || '/'
    return parent === base
  })
}

// GNU tree's ASCII (C-locale) drawing set, matching the docker oracle. A
// link is drawn as `name -> target` and never walked; one leading to a
// directory counts, and filters, as a directory (tree 2.2.1).
async function walkTree(
  readdir: (p: PathSpec) => Promise<string[]>,
  stat: (p: PathSpec) => Promise<FileStat>,
  path: PathSpec,
  prefix: string,
  lines: string[],
  treeOpts: TreeOpts,
  depth: number,
): Promise<{ dirs: number; files: number; failed: boolean; unopened: number }> {
  // `unopened` counts the directories in this subtree (itself included)
  // that could not be opened (a rule refused them below the operand): the
  // caller marks such a child inline the way GNU does and the run exits 2.
  let dirs = 0
  let files = 0
  let unopened = 0
  // The mount table is read before the backend, not merged after it. A
  // directory that exists only because mounts sit under it (`/repos` when
  // `/repos/alpha` is mounted) has no backend to list it, so the readdir
  // throws and a merge below it never runs: `tree` reported the one path
  // whose children it could name for certain as unopenable.
  const nested = childMounts(treeOpts.mounts, path.virtual)
  let entries: string[]
  try {
    entries = await readdir(path)
  } catch (err) {
    if (!isWalkError(err)) throw err
    // An absence only. A directory the backend refused (EACCES, ENOTSUP) is
    // there and holds data, so it stays a warning and an unopened row even
    // when mounts sit under it; swallowing that to draw the children would
    // report a readable tree that is not.
    if (nested.length === 0 || !isMissError(err)) {
      return { dirs, files, failed: true, unopened: 1 }
    }
    entries = []
  }
  if (nested.length > 0) entries = [...new Set([...entries, ...nested])]
  entries.sort(compareCodePoints)
  const filtered: {
    spec: PathSpec
    name: string
    isDir: boolean
    crossing: boolean
    // The stored target a link entry is drawn with; null for any other.
    link: string | null
  }[] = []
  for (const entry of entries) {
    const childPath = rstripSlash(entry)
    const name = childPath.slice(childPath.lastIndexOf('/') + 1)
    if (!treeOpts.showHidden && name.startsWith('.')) continue
    if (treeOpts.ignorePattern !== null && fnmatch(name, treeOpts.ignorePattern)) continue
    const sub = new PathSpec({
      virtual: childPath,
      directory: childPath,
      resolved: false,
      vfsPath: mountKey(childPath, mountPrefixOf(path.virtual, path.vfsPath)),
    })
    const crossing = nested.includes(childPath) && treeOpts.crossReaddir !== null
    let isDir: boolean
    let link: string | null = null
    if (crossing) {
      // The mount table already says this is a directory, and the
      // backend serving it may not stat its own root (an empty mount, or
      // a prefix store with no marker object).
      isDir = true
    } else {
      let s: FileStat
      try {
        s = await stat(sub)
      } catch (err) {
        if (!isWalkError(err)) throw err
        continue
      }
      isDir = s.type === FileType.DIRECTORY
      if (s.type === FileType.SYMLINK) {
        const target = s.extra[LINK_TARGET_KEY]
        link = typeof target === 'string' ? target : ''
        if (treeOpts.targetStat !== null) {
          // One whose target cannot be statted is drawn as a file, as a
          // dangling one is (tree 2.2.1).
          const leads = await treeOpts.targetStat(childPath).catch((err: unknown) => {
            if (!isWalkError(err)) throw err
            console.debug(`tree: cannot stat through ${childPath}: ${String(err)}`)
            return null
          })
          isDir = leads !== null && leads.type === FileType.DIRECTORY
        }
      }
    }
    if (treeOpts.dirsOnly && !isDir) continue
    // -P spares only a real directory, a link to one included in its test
    // (tree 2.2.1).
    if (
      treeOpts.matchPattern !== null &&
      (link !== null || !isDir) &&
      !fnmatch(name, treeOpts.matchPattern)
    )
      continue
    filtered.push({ spec: sub, name, isDir, crossing, link })
  }
  for (let i = 0; i < filtered.length; i++) {
    const entry = filtered[i]
    if (entry === undefined) continue
    const last = i === filtered.length - 1
    const connector = last ? '`-- ' : '|-- '
    const shown = entry.link === null ? entry.name : `${entry.name} -> ${entry.link}`
    lines.push(`${prefix}${connector}${shown}`)
    if (entry.isDir) {
      dirs += 1
      if (entry.link !== null) continue
      if (treeOpts.maxDepth !== null && depth + 1 >= treeOpts.maxDepth) continue
      const nextPrefix = prefix + (last ? '    ' : '|   ')
      // Past a mount root the subtree belongs to another VFS, so the
      // rest of this branch reads through the dispatcher. Deeper mounts
      // under it need no second switch: the dispatcher already routes
      // every path to its owner.
      const subReaddir = entry.crossing ? (treeOpts.crossReaddir ?? readdir) : readdir
      const subStat = entry.crossing ? (treeOpts.crossStat ?? stat) : stat
      const own = lines.length - 1
      const child = await walkTree(
        subReaddir,
        subStat,
        entry.spec,
        nextPrefix,
        lines,
        treeOpts,
        depth + 1,
      )
      if (child.failed) {
        // GNU marks a directory it could not open inline, on the
        // directory's own line, and still counts it.
        lines[own] = `${lines[own] ?? ''}${UNOPENABLE_MARK}`
      }
      dirs += child.dirs
      files += child.files
      unopened += child.unopened
    } else {
      files += 1
    }
  }
  return { dirs, files, failed: false, unopened }
}

function summary(dirs: number, files: number, dirsOnly: boolean): string {
  const dirWord = dirs === 1 ? 'directory' : 'directories'
  if (dirsOnly) return `${String(dirs)} ${dirWord}`
  return `${String(dirs)} ${dirWord}, ${String(files)} ${files === 1 ? 'file' : 'files'}`
}

// List a mount point -x keeps the walk out of: empty, the way GNU tree draws
// a directory on another filesystem.
function notCrossed(): Promise<string[]> {
  return Promise.resolve([])
}

/**
 * Run tree over resolved operands. `unbounded` is the walk to take when no
 * `-L` bounds it (one the mount answers whole), else `readdir` and `stat`.
 * Mirrors Python's `tree_generic`.
 */
export async function treeGeneric(
  paths: PathSpec[],
  ctx: Context,
  readdir: (p: PathSpec) => Promise<string[]>,
  stat: (p: PathSpec) => Promise<FileStat>,
  unbounded?: [(p: PathSpec) => Promise<string[]>, (p: PathSpec) => Promise<FileStat>],
): Promise<CommandFnResult> {
  const parsed = parseFlags(ctx.flags)
  if (unbounded !== undefined && parsed.maxDepth === null) [readdir, stat] = unbounded
  const targets =
    paths.length > 0
      ? paths
      : [
          new PathSpec({
            virtual: ctx.cwd.virtual,
            directory: ctx.cwd.virtual,
            resolved: false,
            vfsPath: mountKey(ctx.cwd.virtual, ctx.mountPrefix ?? ''),
          }),
        ]
  const readdirPath = ctx.readdirPath
  const statPath = ctx.statPath
  const links = linksOf(ctx)
  const treeOpts: TreeOpts = {
    showHidden: parsed.showHidden,
    maxDepth: parsed.maxDepth,
    ignorePattern: parsed.ignorePattern,
    dirsOnly: parsed.dirsOnly,
    matchPattern: parsed.matchPattern,
    mounts: mountsOf(ctx) ?? null,
    crossReaddir:
      readdirPath === undefined
        ? null
        : parsed.oneFileSystem
          ? notCrossed
          : (p: PathSpec) => readdirPath(p.virtual),
    crossStat:
      statPath === undefined
        ? null
        : async (p: PathSpec) => {
            const s = await statPath(p)
            // Stamped, not a bare Error: `isWalkError` keys on the code,
            // so an unstamped throw escapes the walk's catch and rejects
            // the whole run instead of skipping one vanished entry. The
            // python twin raises FileNotFoundError, which `WALK_ERRORS`
            // already covers.
            if (s === null) throw enoent(p)
            return s
          },
    targetStat: links === undefined ? null : (path: string) => links.targetStat(path),
  }
  const lines: string[] = []
  let totalDirs = 0
  let totalFiles = 0
  let anyError = false
  for (const p of targets) {
    const label = p.rawPath !== '' ? p.rawPath : p.virtual
    const before = lines.length
    lines.push(label)
    // What the operand is decides the whole result, so it is resolved
    // before the walk rather than inferred from how a backend answered
    // readdir on it: an object store lists a file key as an empty prefix,
    // lists a missing path as one too, and Graph 404s, which read as
    // three different trees. The probe asks both channels a backend can
    // answer on, so a directory that exists only as its children still
    // reports as one and null means nothing is there.
    //
    // GNU prints the same inline marker either way; what differs is the
    // count and the status. A non-directory exists, so it is counted and
    // the exit stays 0; a path that is not there is not counted and exits 2.
    if (ctx.statPath !== undefined) {
      const start = await ctx.statPath(p)
      if (start === null) {
        lines[before] = `${label}${UNOPENABLE_MARK}`
        anyError = true
        continue
      }
      if (start.type !== FileType.DIRECTORY) {
        lines[before] = `${label}${UNOPENABLE_MARK}`
        totalFiles += 1
        continue
      }
    }
    const counts = await walkTree(readdir, stat, p, '', lines, treeOpts, 0)
    if (counts.failed && lines.length === before + 1) {
      // The root could not be opened (GNU marks it inline and exits 2).
      lines[before] = `${label}${UNOPENABLE_MARK}`
      anyError = true
    } else if (lines.length > before + 1) {
      // GNU counts the root as a directory once it has any listed entry.
      totalDirs += counts.dirs + 1
      totalFiles += counts.files
    }
    // A directory below the root it could not open is marked inline and
    // makes the run exit 2, as GNU does, with nothing on stderr.
    if (counts.unopened > 0) anyError = true
  }
  lines.push('', summary(totalDirs, totalFiles, treeOpts.dirsOnly))
  const out: ByteSource = formatRecords(lines)
  return [out, new IOResult({ exitCode: anyError ? 2 : 0 })]
}
