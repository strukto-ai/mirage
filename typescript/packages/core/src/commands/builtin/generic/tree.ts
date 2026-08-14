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
import { FlagView } from '../../spec/types.ts'
import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { FileType, PathSpec, type FileStat } from '../../../types.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { enoent, isWalkError } from '../../../utils/errors.ts'
import { mountAllowed } from '../../../context/session_context.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import type { MountView } from '../../../ops/types.ts'
import { fnmatch } from '../../../utils/fnmatch.ts'
import { formatRecords } from '../utils/output.ts'
import { compareCodePoints } from '../../../utils/sort.ts'

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
}

// The mount roots mounted directly on this directory. A mount point need
// not exist in the parent backend at all, and when it does the parent
// lists a directory whose contents belong to somebody else. Either way
// the name has to come from the mount table, as `ls` injects it.
//
// Session-filtered, because a crossing entry is drawn from the mount
// table alone: its row is synthesized as a directory without asking any
// backend, so the dispatcher never gets the chance to refuse it and an
// ungranted mount's name would reach the drawing. `ls` filters the same
// fact through `childMountNames`. Note this is the opposite of what `du`
// wants from the same view: there an ungranted mount still shadows the
// parent's keys, so its prefix must stay in the list even though the
// walk never enters it.
function childMounts(mounts: MountView | null, directory: string): string[] {
  if (mounts === null) return []
  const base = rstripSlash(directory) || '/'
  return mounts.descendants(directory).filter((root) => {
    const parent = root.slice(0, root.lastIndexOf('/')) || '/'
    return parent === base && mountAllowed(root)
  })
}

// GNU tree's ASCII (C-locale) drawing set, matching the docker oracle.
async function walkTree(
  readdir: (p: PathSpec) => Promise<string[]>,
  stat: (p: PathSpec) => Promise<FileStat>,
  path: PathSpec,
  prefix: string,
  lines: string[],
  treeOpts: TreeOpts,
  depth: number,
): Promise<{ dirs: number; files: number; failed: boolean }> {
  let dirs = 0
  let files = 0
  let entries: string[]
  try {
    entries = await readdir(path)
  } catch (err) {
    if (!isWalkError(err)) throw err
    return { dirs, files, failed: true }
  }
  const nested = childMounts(treeOpts.mounts, path.virtual)
  if (nested.length > 0) entries = [...new Set([...entries, ...nested])]
  entries.sort(compareCodePoints)
  const filtered: { spec: PathSpec; name: string; isDir: boolean; crossing: boolean }[] = []
  for (const entry of entries) {
    const childPath = rstripSlash(entry)
    const name = childPath.slice(childPath.lastIndexOf('/') + 1)
    if (!treeOpts.showHidden && name.startsWith('.')) continue
    if (treeOpts.ignorePattern !== null && fnmatch(name, treeOpts.ignorePattern)) continue
    const sub = new PathSpec({
      virtual: childPath,
      directory: childPath,
      resolved: false,
      resourcePath: mountKey(childPath, mountPrefixOf(path.virtual, path.resourcePath)),
    })
    const crossing = nested.includes(childPath) && treeOpts.crossReaddir !== null
    let isDir: boolean
    if (crossing) {
      // The mount table already says this is a directory, and the
      // backend serving it may not stat its own root (an empty mount, or
      // a prefix store with no marker object).
      isDir = true
    } else {
      try {
        const s = await stat(sub)
        isDir = s.type === FileType.DIRECTORY
      } catch (err) {
        if (!isWalkError(err)) throw err
        continue
      }
    }
    if (treeOpts.dirsOnly && !isDir) continue
    if (treeOpts.matchPattern !== null && !isDir && !fnmatch(name, treeOpts.matchPattern)) continue
    filtered.push({ spec: sub, name, isDir, crossing })
  }
  for (let i = 0; i < filtered.length; i++) {
    const entry = filtered[i]
    if (entry === undefined) continue
    const last = i === filtered.length - 1
    const connector = last ? '`-- ' : '|-- '
    lines.push(`${prefix}${connector}${entry.name}`)
    if (entry.isDir) {
      dirs += 1
      if (treeOpts.maxDepth !== null && depth + 1 >= treeOpts.maxDepth) continue
      const nextPrefix = prefix + (last ? '    ' : '|   ')
      // Past a mount root the subtree belongs to another resource, so the
      // rest of this branch reads through the dispatcher. Deeper mounts
      // under it need no second switch: the dispatcher already routes
      // every path to its owner.
      const subReaddir = entry.crossing ? (treeOpts.crossReaddir ?? readdir) : readdir
      const subStat = entry.crossing ? (treeOpts.crossStat ?? stat) : stat
      const child = await walkTree(
        subReaddir,
        subStat,
        entry.spec,
        nextPrefix,
        lines,
        treeOpts,
        depth + 1,
      )
      dirs += child.dirs
      files += child.files
    } else {
      files += 1
    }
  }
  return { dirs, files, failed: false }
}

function treeSummary(dirs: number, files: number, dirsOnly: boolean): string {
  const dirWord = dirs === 1 ? 'directory' : 'directories'
  if (dirsOnly) return `${String(dirs)} ${dirWord}`
  return `${String(dirs)} ${dirWord}, ${String(files)} ${files === 1 ? 'file' : 'files'}`
}

export async function treeGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  readdir: (p: PathSpec) => Promise<string[]>,
  stat: (p: PathSpec) => Promise<FileStat>,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf('tree'))
  const targets =
    paths.length > 0
      ? paths
      : [
          new PathSpec({
            virtual: opts.cwd,
            directory: opts.cwd,
            resolved: false,
            resourcePath: mountKey(opts.cwd, opts.mountPrefix ?? ''),
          }),
        ]
  const depthRaw = fl.asStr('L') ?? null
  const ignoreRaw = fl.asStr('args_I') ?? null
  const matchRaw = fl.asStr('P') ?? null
  const readdirPath = opts.readdirPath
  const statPath = opts.statPath
  const treeOpts: TreeOpts = {
    showHidden: fl.asBool('a'),
    maxDepth: depthRaw === null ? null : Number.parseInt(depthRaw, 10),
    ignorePattern: ignoreRaw,
    dirsOnly: fl.asBool('d'),
    matchPattern: matchRaw,
    mounts: opts.ns?.mounts ?? null,
    crossReaddir: readdirPath === undefined ? null : (p: PathSpec) => readdirPath(p.virtual),
    crossStat:
      statPath === undefined
        ? null
        : async (p: PathSpec) => {
            const s = await statPath(p.virtual)
            // Stamped, not a bare Error: `isWalkError` keys on the code,
            // so an unstamped throw escapes the walk's catch and rejects
            // the whole run instead of skipping one vanished entry. The
            // python twin raises FileNotFoundError, which `WALK_ERRORS`
            // already covers.
            if (s === null) throw enoent(p)
            return s
          },
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
    if (opts.statPath !== undefined) {
      const start = await opts.statPath(p.virtual)
      if (start === null) {
        lines[before] = `${label}  [error opening dir]`
        anyError = true
        continue
      }
      if (start.type !== FileType.DIRECTORY) {
        lines[before] = `${label}  [error opening dir]`
        totalFiles += 1
        continue
      }
    }
    const counts = await walkTree(readdir, stat, p, '', lines, treeOpts, 0)
    if (counts.failed && lines.length === before + 1) {
      // The root could not be opened (GNU marks it inline and exits 2).
      lines[before] = `${label}  [error opening dir]`
      anyError = true
    } else if (lines.length > before + 1) {
      // GNU counts the root as a directory once it has any listed entry.
      totalDirs += counts.dirs + 1
      totalFiles += counts.files
    }
  }
  lines.push('', treeSummary(totalDirs, totalFiles, treeOpts.dirsOnly))
  const out: ByteSource = formatRecords(lines)
  return [out, new IOResult({ exitCode: anyError ? 2 : 0 })]
}
