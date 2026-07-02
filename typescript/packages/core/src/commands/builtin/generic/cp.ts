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
import type { FindOptions } from '../../../resource/base.ts'
import { FileType, PathSpec } from '../../../types.ts'
import type { CommandFnResult } from '../../config.ts'
import {
  backendKeyDefault,
  copyTargets,
  isDirectory,
  pathExists,
  type BackendKeyFn,
  type StatFn,
} from '../utils/copy.ts'
import { rstripSlash } from '../../../utils/slash.ts'

const ENC = new TextEncoder()

type CopyFn = (src: PathSpec, target: PathSpec) => Promise<void>
type FindFn = (src: PathSpec, options: FindOptions) => Promise<string[]>

// Low-level primitives for the no-native-copy recursive path (cross-mount).
// Backends that inject copy/find never use these.
export interface CpPrimitives {
  readBytes: (p: PathSpec) => Promise<Uint8Array>
  write: (p: PathSpec, data: Uint8Array) => Promise<void>
  mkdir: (p: PathSpec) => Promise<void>
  readdir: (p: PathSpec) => Promise<string[]>
}

// List a tree as {path, isDir} pairs, parents before children. The type is
// captured while the tree is intact so a caller that deletes as it goes (mv)
// never re-stats a path whose virtual parent has since vanished. Mirrors the
// Python cp `walk`; used only by the primitive (no native copy) path.
export async function cpWalk(
  readdir: (p: PathSpec) => Promise<string[]>,
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

export async function cpGeneric(
  paths: PathSpec[],
  copy: CopyFn,
  find: FindFn,
  stat: StatFn,
  recursive: boolean,
  noClobber: boolean,
  verbose: boolean,
  index?: IndexCacheStore,
  backendKey?: BackendKeyFn,
  dirCopy?: CopyFn,
  prim?: CpPrimitives,
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
      if (prim !== undefined) {
        for (const { path: entry, isDir } of await cpWalk(prim.readdir, stat, src, index)) {
          const entryDst = dstBase + entry.slice(srcBase.length)
          const entryDstSpec = PathSpec.fromStrPath(entryDst)
          if (isDir) {
            if (!(await isDirectory(stat, entryDstSpec, index))) {
              await prim.mkdir(entryDstSpec)
              writes[entryDst] = new Uint8Array()
              if (verbose) lines.push(`'${entry}' -> '${entryDst}'`)
            }
            continue
          }
          if (noClobber && (await pathExists(stat, entryDstSpec))) continue
          await prim.write(entryDstSpec, await prim.readBytes(PathSpec.fromStrPath(entry)))
          writes[entryDst] = new Uint8Array()
          if (verbose) lines.push(`'${entry}' -> '${entryDst}'`)
        }
        continue
      }
      if (dirCopy !== undefined) {
        if (noClobber && (await pathExists(stat, target))) continue
        await dirCopy(src, target)
        for (const entry of await find(src, { type: 'f' })) {
          const entryDst = dstBase + entry.slice(srcBase.length)
          writes[entryDst] = new Uint8Array()
          if (verbose) lines.push(`'${entry}' -> '${entryDst}'`)
        }
        continue
      }
      for (const entry of await find(src, { type: 'f' })) {
        const entryDst = dstBase + entry.slice(srcBase.length)
        const entryDstSpec = PathSpec.fromStrPath(entryDst)
        if (noClobber && (await pathExists(stat, entryDstSpec))) continue
        await copy(PathSpec.fromStrPath(entry), entryDstSpec)
        writes[entryDst] = new Uint8Array()
        if (verbose) lines.push(`'${entry}' -> '${entryDst}'`)
      }
      continue
    }
    if (noClobber && (await pathExists(stat, target))) continue
    await copy(src, target)
    writes[target.mountPath] = new Uint8Array()
    if (verbose) lines.push(`'${src.virtual}' -> '${target.virtual}'`)
  }
  const output: ByteSource | null = lines.length > 0 ? ENC.encode(lines.join('\n') + '\n') : null
  const stderr = errors.length > 0 ? ENC.encode(errors.join('\n') + '\n') : null
  return [output, new IOResult({ writes, stderr, exitCode: errors.length > 0 ? 1 : 0 })]
}
