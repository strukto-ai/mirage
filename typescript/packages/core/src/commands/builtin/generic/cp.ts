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

import { rekey } from '../../../utils/key_prefix.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import {
  FileType,
  PathSpec,
  type CopyStrategy,
  type PrimitiveCopy,
  type PrimitiveMove,
  type ReaddirFn,
  type StatFn,
} from '../../../types.ts'
import type { CommandFnResult } from '../../config.ts'
import {
  backendKeyDefault,
  copyTargets,
  isDirectory,
  pathExists,
  type BackendKeyFn,
} from '../utils/copy.ts'
import { fsStrerror, isFsError } from '../../../utils/errors.ts'
import { rstripSlash } from '../../../utils/slash.ts'

const ENC = new TextEncoder()

function isPrimitiveCopy(strategy: CopyStrategy): strategy is PrimitiveCopy {
  return 'readBytes' in strategy
}

// List a tree as {path, isDir} pairs, parents before children. The type is
// captured while the tree is intact so a caller that deletes as it goes (mv)
// never re-stats a path whose virtual parent has since vanished. Mirrors the
// Python cp `walk`; used only by the primitive (no native copy) path.
export async function cpWalk(
  readdir: ReaddirFn,
  stat: StatFn,
  root: PathSpec,
  index?: IndexCacheStore,
): Promise<{ path: string; isDir: boolean }[]> {
  const info = await stat(root, index)
  if (info.type !== FileType.DIRECTORY) return [{ path: root.virtual, isDir: false }]
  const entries: { path: string; isDir: boolean }[] = [{ path: root.virtual, isDir: true }]
  const queue: PathSpec[] = [root]
  while (queue.length > 0) {
    const directory = queue.shift()
    if (directory === undefined) break
    for (const child of await readdir(directory)) {
      const childSpec = PathSpec.fromStrPath(child, rekey(root.virtual, root.resourcePath, child))
      const childInfo = await stat(childSpec, index)
      const isDir = childInfo.type === FileType.DIRECTORY
      entries.push({ path: child, isDir })
      if (isDir) queue.push(childSpec)
    }
  }
  return entries
}

// Copy a walked source tree entry by entry with GNU per-entry errors: the
// shared primitive-transfer loop of cp and mv. A failed mkdir aborts the
// source (its children cannot be created); a failed read or write is
// reported and the remaining entries still copy, like GNU cp/mv on a
// cross-device transfer. `writes` and `lines` are optional per-entry sinks
// (cp records them; mv keys its IOResult off the returned flags instead);
// `noClobber` skips file entries whose target already exists. Returns
// whether every entry landed and whether the destination changed at all.
export async function copyEntries(
  cmdName: string,
  strategy: PrimitiveCopy | PrimitiveMove,
  stat: StatFn,
  src: PathSpec,
  target: PathSpec,
  entries: { path: string; isDir: boolean }[],
  errors: string[],
  index?: IndexCacheStore,
  opts: {
    noClobber?: boolean
    writes?: Record<string, ByteSource>
    lines?: string[] | undefined
  } = {},
): Promise<{ copiedAll: boolean; wroteAny: boolean }> {
  const srcBase = rstripSlash(src.mountPath)
  const dstBase = rstripSlash(target.mountPath)
  let copiedAll = true
  let wroteAny = false
  for (const { path: entry, isDir } of entries) {
    const entryDst = dstBase + entry.slice(srcBase.length)
    const entryDstSpec = PathSpec.fromStrPath(entryDst)
    if (isDir) {
      try {
        if (!(await isDirectory(stat, entryDstSpec, index))) {
          await strategy.mkdir(entryDstSpec)
          wroteAny = true
          if (opts.writes !== undefined) opts.writes[entryDst] = new Uint8Array()
          if (opts.lines !== undefined) opts.lines.push(`'${entry}' -> '${entryDst}'`)
        }
      } catch (err) {
        // GNU stops this source: the children of a directory it could
        // not create cannot land.
        if (!isFsError(err)) throw err
        errors.push(`${cmdName}: cannot create directory '${entryDst}': ${String(fsStrerror(err))}`)
        return { copiedAll: false, wroteAny }
      }
      continue
    }
    if (opts.noClobber === true && (await pathExists(stat, entryDstSpec))) continue
    let data: Uint8Array
    try {
      data = await strategy.readBytes(PathSpec.fromStrPath(entry))
    } catch (err) {
      if (!isFsError(err)) throw err
      errors.push(`${cmdName}: cannot open '${entry}' for reading: ${String(fsStrerror(err))}`)
      copiedAll = false
      continue
    }
    try {
      await strategy.write(entryDstSpec, data)
    } catch (err) {
      if (!isFsError(err)) throw err
      errors.push(
        `${cmdName}: cannot create regular file '${entryDst}': ${String(fsStrerror(err))}`,
      )
      copiedAll = false
      continue
    }
    wroteAny = true
    if (opts.writes !== undefined) opts.writes[entryDst] = new Uint8Array()
    if (opts.lines !== undefined) opts.lines.push(`'${entry}' -> '${entryDst}'`)
  }
  return { copiedAll, wroteAny }
}

export async function cpGeneric(
  paths: PathSpec[],
  stat: StatFn,
  strategy: CopyStrategy,
  recursive: boolean,
  noClobber: boolean,
  verbose: boolean,
  index?: IndexCacheStore,
  backendKey?: BackendKeyFn,
): Promise<CommandFnResult> {
  const keyOf = backendKey ?? backendKeyDefault
  const sources = paths.slice(0, -1)
  const dst = paths[paths.length - 1]
  if (dst === undefined) return [null, new IOResult()]
  const dstIsDir = await isDirectory(stat, dst, index)
  const writes: Record<string, ByteSource> = {}
  const lines: string[] = []
  const errors: string[] = []
  for (const [src, target] of copyTargets(sources, dst, dstIsDir)) {
    if (!(await pathExists(stat, src))) {
      errors.push(`cp: cannot stat '${src.virtual}': No such file or directory`)
      continue
    }
    if (keyOf(src) === keyOf(target)) {
      errors.push(`cp: '${src.virtual}' and '${target.virtual}' are the same file`)
      continue
    }
    if (recursive && keyOf(target).startsWith(keyOf(src) + '/')) {
      errors.push(`cp: cannot copy a directory, '${src.virtual}', into itself, '${target.virtual}'`)
      continue
    }
    if (!recursive && (await isDirectory(stat, src, index))) {
      errors.push(`cp: -r not specified; omitting directory '${src.virtual}'`)
      continue
    }
    if (recursive) {
      const srcBase = rstripSlash(src.mountPath)
      const dstBase = rstripSlash(target.mountPath)
      if (isPrimitiveCopy(strategy)) {
        const entries = await cpWalk(strategy.readdir, stat, src, index)
        await copyEntries('cp', strategy, stat, src, target, entries, errors, index, {
          noClobber,
          writes,
          lines: verbose ? lines : undefined,
        })
        continue
      }
      if (strategy.dirCopy !== undefined) {
        if (noClobber && (await pathExists(stat, target))) continue
        await strategy.dirCopy(src, target)
        for (const entry of await strategy.find(src, { type: 'f' })) {
          const entryDst = dstBase + entry.slice(srcBase.length)
          writes[entryDst] = new Uint8Array()
          if (verbose) lines.push(`'${entry}' -> '${entryDst}'`)
        }
        continue
      }
      for (const entry of await strategy.find(src, { type: 'f' })) {
        const entryDst = dstBase + entry.slice(srcBase.length)
        const entryDstSpec = PathSpec.fromStrPath(entryDst)
        if (noClobber && (await pathExists(stat, entryDstSpec))) continue
        await strategy.copy(PathSpec.fromStrPath(entry), entryDstSpec)
        writes[entryDst] = new Uint8Array()
        if (verbose) lines.push(`'${entry}' -> '${entryDst}'`)
      }
      continue
    }
    if (noClobber && (await pathExists(stat, target))) continue
    if (isPrimitiveCopy(strategy)) {
      let data: Uint8Array
      try {
        data = await strategy.readBytes(src)
      } catch (err) {
        if (!isFsError(err)) throw err
        errors.push(`cp: cannot open '${src.virtual}' for reading: ${String(fsStrerror(err))}`)
        continue
      }
      try {
        await strategy.write(target, data)
      } catch (err) {
        if (!isFsError(err)) throw err
        errors.push(
          `cp: cannot create regular file '${target.virtual}': ${String(fsStrerror(err))}`,
        )
        continue
      }
    } else {
      await strategy.copy(src, target)
    }
    writes[target.mountPath] = new Uint8Array()
    if (verbose) lines.push(`'${src.virtual}' -> '${target.virtual}'`)
  }
  const output: ByteSource | null = lines.length > 0 ? ENC.encode(lines.join('\n') + '\n') : null
  const stderr = errors.length > 0 ? ENC.encode(errors.join('\n') + '\n') : null
  return [output, new IOResult({ writes, stderr, exitCode: errors.length > 0 ? 1 : 0 })]
}
