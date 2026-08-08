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
import { isWalkError } from '../../../utils/errors.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { fnmatch } from '../../../utils/fnmatch.ts'
import { formatRecords } from '../utils/output.ts'

interface TreeOpts {
  showHidden: boolean
  maxDepth: number | null
  ignorePattern: string | null
  dirsOnly: boolean
  matchPattern: string | null
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
  entries.sort()
  const filtered: { spec: PathSpec; name: string; isDir: boolean }[] = []
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
    let isDir: boolean
    try {
      const s = await stat(sub)
      isDir = s.type === FileType.DIRECTORY
    } catch (err) {
      if (!isWalkError(err)) throw err
      continue
    }
    if (treeOpts.dirsOnly && !isDir) continue
    if (treeOpts.matchPattern !== null && !isDir && !fnmatch(name, treeOpts.matchPattern)) continue
    filtered.push({ spec: sub, name, isDir })
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
      const child = await walkTree(
        readdir,
        stat,
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
  const treeOpts: TreeOpts = {
    showHidden: fl.asBool('a'),
    maxDepth: depthRaw === null ? null : Number.parseInt(depthRaw, 10),
    ignorePattern: ignoreRaw,
    dirsOnly: fl.asBool('d'),
    matchPattern: matchRaw,
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
